import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { kempoCreditEntry, kempoCreditLot } from '../../db/schema.js';
import newId from '../ids.js';
import { abort } from './transaction.js';

/*
  The pieces every ledger operation is built from. Each takes the transaction it runs in, and
  assumes the caller holds the user's lock (see transaction.js).
*/

const DAY = 86400000;

/*
  A lot counts towards a balance when it has not expired — or when it is below zero, because a debt
  does not expire just because the credits it came from would have.
*/
export const isLive = (lot, now) => lot.remaining < 0 || !lot.expiresAt || new Date(lot.expiresAt).getTime() > now.getTime();

/*
  The order credits are spent in: whatever expires soonest first, so nobody loses credits to expiry
  while longer-lived ones are drawn; promo before paid when they expire together, so a user never
  loses free credits while bought ones are used; and oldest first after that.
*/
export const SPENDING_ORDER = lot => [
  sql`${lot.expiresAt} asc nulls last`,
  sql`(${lot.kind} = 'promo') desc`,
  asc(lot.createdAt),
  asc(lot.id),
];

export const spendableLots = (tx, userId, now) => tx.select().from(kempoCreditLot)
  .where(and(
    eq(kempoCreditLot.userId, userId),
    gt(kempoCreditLot.remaining, 0),
    or(isNull(kempoCreditLot.expiresAt), gt(kempoCreditLot.expiresAt, now)),
  ))
  .orderBy(...SPENDING_ORDER(kempoCreditLot));

export const owingLots = (tx, userId) => tx.select().from(kempoCreditLot)
  .where(and(eq(kempoCreditLot.userId, userId), lt(kempoCreditLot.remaining, 0)))
  .orderBy(asc(kempoCreditLot.createdAt), asc(kempoCreditLot.id));

/*
  The balance, worked out from the lots. Nothing caches it, so this is the only definition of it.
*/
export const summarise = (lots, now, { expiringSoonDays = 14 } = {}) => {
  const soon = now.getTime() + expiringSoonDays * DAY;
  const balance = { total: 0, paid: 0, promo: 0, owed: 0, expiringSoon: 0, nextExpiresAt: null };

  for(const lot of lots){
    if(!isLive(lot, now)) continue;
    balance[lot.kind === 'promo' ? 'promo' : 'paid'] += lot.remaining;
    balance.total += lot.remaining;
    if(lot.remaining < 0) balance.owed -= lot.remaining;

    if(lot.remaining > 0 && lot.expiresAt){
      const at = new Date(lot.expiresAt);
      if(at.getTime() <= soon) balance.expiringSoon += lot.remaining;
      if(!balance.nextExpiresAt || at < balance.nextExpiresAt) balance.nextExpiresAt = at;
    }
  }

  return balance;
};

export const balanceIn = async (tx, userId, now, options) => summarise(
  await tx.select().from(kempoCreditLot).where(and(eq(kempoCreditLot.userId, userId), sql`${kempoCreditLot.remaining} <> 0`)),
  now,
  options,
);

/*
  The first entry of the operation filed under this key, and every entry in that operation. Null when
  the key has not been used.
*/
export const findOperation = async (tx, userId, key) => {
  const [first] = await tx.select().from(kempoCreditEntry)
    .where(and(eq(kempoCreditEntry.userId, userId), eq(kempoCreditEntry.idempotencyKey, key)))
    .limit(1);
  if(!first) return null;

  const entries = await operationEntries(tx, first.operationId);
  return { first, entries };
};

export const operationEntries = (tx, operationId) => tx.select().from(kempoCreditEntry)
  .where(eq(kempoCreditEntry.operationId, operationId))
  .orderBy(asc(kempoCreditEntry.createdAt), asc(kempoCreditEntry.id));

/*
  Applies a list of moves to lots and writes an entry for each, as one operation.

  A move that takes credits away is conditional — the lot must still have them — so an operation can
  never take a lot below zero, even if the lock somehow failed to serialise it. Only a `shortfall`
  is allowed to, because recording that a lot is below zero is exactly what a shortfall is.
*/
export const writeOperation = async (tx, { userId, operationId, key = null, reason = null, reference = null, reversesOperationId = null, actorId = null, note = null, now }, moves) => {
  const entries = [];

  for(const [index, move] of moves.entries()){
    if(!move.amount) continue;

    const guarded = move.amount < 0 && move.type !== 'shortfall';
    const [lot] = await tx.update(kempoCreditLot)
      .set({ remaining: sql`${kempoCreditLot.remaining} + ${move.amount}`, updatedAt: now })
      .where(guarded
        ? and(eq(kempoCreditLot.id, move.lotId), sql`${kempoCreditLot.remaining} + ${move.amount} >= 0`)
        : eq(kempoCreditLot.id, move.lotId))
      .returning({ id: kempoCreditLot.id, kind: kempoCreditLot.kind, remaining: kempoCreditLot.remaining });

    if(!lot) abort(409, 'The balance changed while this was being done — try again');

    const entry = {
      id: newId('ent'),
      userId,
      lotId: move.lotId,
      operationId,
      type: move.type,
      amount: move.amount,
      reason,
      referenceOwner: reference?.owner ?? null,
      referenceId: reference?.ref ?? null,
      idempotencyKey: entries.length === 0 ? key : null,
      reversesOperationId,
      actorId,
      note,
      // Entries in one operation share a timestamp but keep their order.
      createdAt: new Date(now.getTime() + index),
    };
    await tx.insert(kempoCreditEntry).values(entry);
    entries.push({ ...entry, kind: lot.kind });
  }

  return entries;
};

/*
  Moves `amount` out of lots in spending order. Returns the moves, or null when the lots do not hold
  enough — the caller decides what "not enough" means for it.
*/
export const takeInOrder = (lots, amount, type) => {
  const moves = [];
  let left = amount;

  for(const lot of lots){
    if(left <= 0) break;
    const take = Math.min(lot.remaining, left);
    if(take <= 0) continue;
    moves.push({ lotId: lot.id, type, amount: -take, kind: lot.kind });
    left -= take;
  }

  return left > 0 ? null : moves;
};

/*
  Writes off whatever is left in this user's expired lots, as `expiry` entries.

  A balance never counts an expired lot whether or not this has run — see `isLive`. This is what
  makes the ledger say so: without it, a user's entries would add up to more than their balance and
  nothing would explain the difference. It runs at the start of every operation on the user — inside
  that operation's transaction, so one that is refused writes nothing, this included — and
  `expireLots` runs it for everybody.
*/
export const expireDue = async (tx, userId, now) => {
  const due = await tx.select().from(kempoCreditLot)
    .where(and(eq(kempoCreditLot.userId, userId), gt(kempoCreditLot.remaining, 0), lte(kempoCreditLot.expiresAt, now)))
    .orderBy(asc(kempoCreditLot.expiresAt), asc(kempoCreditLot.id));

  if(!due.length) return [];

  return writeOperation(tx, { userId, operationId: newId('op'), reason: 'expired', now }, due.map(lot => ({
    lotId: lot.id,
    type: 'expiry',
    amount: -lot.remaining,
  })));
};

/*
  Pays off negative lots from positive ones, oldest debt first, positive lots in spending order.
  Moves credits only: the user's total does not change, which is the point — a debt and a balance
  are never both showing at once.
*/
export const settle = async (tx, { userId, operationId, now, reason = 'settlement', actorId = null }) => {
  const owing = await owingLots(tx, userId);
  if(!owing.length) return [];

  const sources = await spendableLots(tx, userId, now);
  const moves = [];

  for(const debt of owing){
    let needed = -debt.remaining;
    for(const source of sources){
      if(needed <= 0) break;
      const take = Math.min(source.remaining, needed);
      if(take <= 0) continue;
      source.remaining -= take;
      needed -= take;
      moves.push({ lotId: source.id, type: 'settlement', amount: -take });
      moves.push({ lotId: debt.id, type: 'settlement', amount: take });
    }
  }

  return writeOperation(tx, { userId, operationId, reason, actorId, now }, moves);
};

export const recentEntries = (tx, userId, limit = 50) => tx.select().from(kempoCreditEntry)
  .where(eq(kempoCreditEntry.userId, userId))
  .orderBy(desc(kempoCreditEntry.createdAt), desc(kempoCreditEntry.id))
  .limit(limit);
