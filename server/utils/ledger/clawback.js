import { and, eq, inArray } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoCreditEntry, kempoCreditLot } from '../../db/schema.js';
import { readConfig } from '../config/settings.js';
import newId from '../ids.js';
import { crossedLow, fire, notifyAdmins } from './events.js';
import { balanceIn, findOperation, spendableLots, summarise, writeOperation } from './lots.js';
import { abort, withUserLocks } from './transaction.js';
import { cleanAmount, cleanKey, cleanReference, cleanText } from './validate.js';

/*
  Takes back a grant — what a refund of the purchase behind it does.

  ```js
  const [error, result] = await clawBackGrant({ reference: { owner: 'kempo-credits', ref: purchase.id } });
  // or { lotId }, and optionally `amount` to take back only part of it
  ```

  The credits come from the grant's own lot first and then from the user's other credits, oldest
  first. A refund an extension makes through its own screens should never need more than the user
  still holds — kempo-credit-packs refuses one that would, using `getGrant` below, because spent
  credits are never refunded as money; if something was spent on a thing the user never received, an
  administrator gives those credits back first, by reversing the spend or granting them.

  A refund made somewhere that extension cannot stop — the processor's own dashboard, or a
  chargeback — can still take back more than the user holds. What could not be taken is the **shortfall**: a
  `shortfall` entry takes the lot below zero, so the balance shows what is owed; spending is blocked
  until credits granted later have paid it off or an administrator writes it off; and every person
  who can see credits is notified.

  **What if they have already spent some?** That is the caller's decision, passed as `ifShort`:

  - `'owe'` (the default): take what they hold and record the rest as a **shortfall** — the balance
    goes below zero, spending is blocked until later credits pay it off or an administrator writes
    it off, and every person who can see credits is notified. The user then owes the credits.
  - `'zero'`: take what they hold and leave it there. Their balance is zero and nobody owes
    anything; the part that was already spent is `unrecovered` in the result and the hook, and
    the grant is closed so credits they earn later are never taken for it.

  `previewClawBack` says beforehand how much would be taken and how much is short, which is what
  an administrator approving a refund needs to see.

  How much of a grant is already back is counted from the entries that name it
  (`reversesOperationId`), wherever they took credits from. Credits an administrator removed from
  the lot were never used by anybody and are not counted against the user. A grant with nothing left
  to take back is a 409.
*/

const TAKEN = ['clawback', 'shortfall'];

const sumOf = entries => -entries.reduce((sum, entry) => sum + entry.amount, 0);

/*
  Where a grant stands: how many of its credits have been taken back for it (wherever they were taken
  from), how many an administrator removed from it, and so how many can still be taken back.
*/
export const grantState = async (handle, lot) => {
  const taken = await handle.select().from(kempoCreditEntry)
    .where(and(eq(kempoCreditEntry.reversesOperationId, lot.operationId), inArray(kempoCreditEntry.type, TAKEN)));
  const removed = await handle.select().from(kempoCreditEntry)
    .where(and(eq(kempoCreditEntry.lotId, lot.id), eq(kempoCreditEntry.type, 'removal')));
  const closing = await handle.select().from(kempoCreditEntry)
    .where(and(eq(kempoCreditEntry.reversesOperationId, lot.operationId), eq(kempoCreditEntry.type, 'forfeit')));
  const clawed = sumOf(taken);
  const gone = sumOf(removed);
  const closed = closing.length > 0;
  return { clawed, removed: gone, closed, claimable: closed ? 0 : Math.max(0, lot.amount - clawed - gone) };
};

/*
  What a claw back would do right now, without doing it: how many credits are still to be taken
  back for the grant (`claimable`, or `amount` if less), how many of the user's credits are there
  to take (`held`), and so how many it would take (`takeable`) and how many are `shortfall` — the
  ones they have already spent. The answer is a moment in time; the claw back itself is what holds
  the user's lock.
*/
export const previewClawBack = async ({ lotId, reference, amount } = {}) => {
  const [cleanError, cleanRef] = cleanReference(lotId ? null : reference);
  if(cleanError) return [cleanError, null];
  if(!lotId && !cleanRef) return [{ code: 400, msg: 'Say which grant: a lotId or its reference' }, null];
  if(amount !== undefined && amount !== null){
    const [amountError] = cleanAmount(amount);
    if(amountError) return [amountError, null];
  }

  const [error, lot] = await findLot({ lotId, reference: cleanRef });
  if(error) return [error, null];

  try {
    const state = await grantState(db, lot);
    const lots = await db.select().from(kempoCreditLot).where(eq(kempoCreditLot.userId, lot.userId));
    const held = lots.reduce((sum, row) => sum + Math.max(0, row.remaining), 0);
    const wanted = amount ? Math.min(amount, state.claimable) : state.claimable;
    const takeable = Math.min(wanted, held);
    return [null, {
      userId: lot.userId,
      lot,
      claimable: state.claimable,
      wanted,
      held,
      takeable,
      shortfall: wanted - takeable,
      balance: summarise(lots),
    }];
  } catch {
    return [{ code: 500, msg: 'Could not preview the claw back' }, null];
  }
};

/*
  A grant and where it stands: `{ lot, clawed, removed, claimable }` — how many of its credits have
  been taken back for it (wherever they were taken from), how many an administrator removed from it,
  and so how many can still be taken back. This is what an extension that sells or awards credits
  needs to decide how far a refund may go.
*/
export const getGrant = async ({ lotId, reference } = {}) => {
  const [cleanError, cleanRef] = cleanReference(lotId ? null : reference);
  if(cleanError) return [cleanError, null];
  if(!lotId && !cleanRef) return [{ code: 400, msg: 'Say which grant: a lotId or its reference' }, null];

  const [error, lot] = await findLot({ lotId, reference: cleanRef });
  if(error) return [error, null];

  try {
    return [null, { lot, ...await grantState(db, lot) }];
  } catch {
    return [{ code: 500, msg: 'Could not load the grant' }, null];
  }
};

export const findLot = async ({ lotId, reference }) => {
  try {
    if(lotId){
      const [lot] = await db.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, lotId)).limit(1);
      return lot ? [null, lot] : [{ code: 404, msg: 'No such lot' }, null];
    }

    const lots = await db.select().from(kempoCreditLot)
      .where(and(eq(kempoCreditLot.referenceOwner, reference.owner), eq(kempoCreditLot.referenceId, reference.ref)))
      .limit(2);
    if(!lots.length) return [{ code: 404, msg: 'No grant has that reference' }, null];
    if(lots.length > 1) return [{ code: 409, msg: 'More than one grant has that reference — claw back by lot id instead' }, null];
    return [null, lots[0]];
  } catch {
    return [{ code: 500, msg: 'Could not load the lot' }, null];
  }
};

export const clawBackGrant = async ({ lotId, reference, amount, reason = 'clawback', ifShort = 'owe', idempotencyKey, actorId = null, note = null } = {}) => {
  if(!['owe', 'zero'].includes(ifShort)) return [{ code: 400, msg: "ifShort is 'owe' or 'zero'" }, null];
  if(!lotId && !reference) return [{ code: 400, msg: 'Say which grant to claw back: a lotId or its reference' }, null];
  if(lotId && typeof lotId !== 'string') return [{ code: 400, msg: 'That is not a lot id' }, null];

  const [referenceError, cleanRef] = cleanReference(lotId ? null : reference);
  if(referenceError) return [referenceError, null];
  if(amount !== undefined && amount !== null){
    const [amountError] = cleanAmount(amount);
    if(amountError) return [amountError, null];
  }
  const [keyError, key] = idempotencyKey === undefined || idempotencyKey === null ? [null, null] : cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  const [reasonError, cleanReason] = cleanText(reason, 'A reason', { max: 100 });
  if(reasonError) return [reasonError, null];
  const [noteError, cleanNote] = cleanText(note, 'A note');
  if(noteError) return [noteError, null];

  const [lotError, found] = await findLot({ lotId, reference: cleanRef });
  if(lotError) return [lotError, null];

  const config = await readConfig();
  const now = new Date();
  const userId = found.userId;

  const [error, result] = await withUserLocks([userId], async tx => {
    if(key){
      const existing = await findOperation(tx, userId, key);
      if(existing){
        const { first, entries } = existing;
        if(!TAKEN.includes(first.type) && first.type !== 'forfeit') abort(409, `That idempotency key was already used for a ${first.type}, not a claw back`);
        const [lot] = await tx.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, found.id));
        const balance = await balanceIn(tx, userId);
        const taken = sumOf(entries.filter(entry => entry.type === 'clawback'));
        const shortfall = sumOf(entries.filter(entry => entry.type === 'shortfall'));
        return [null, { duplicate: true, operationId: first.operationId, lot, clawedBack: taken + shortfall, taken, shortfall, unrecovered: null, owed: balance.owed, balance, before: balance }];
      }
    }

    const [lot] = await tx.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, found.id));
    const { claimable } = await grantState(tx, lot);
    if(claimable <= 0) abort(409, 'Nothing is left of this grant to claw back');

    const wanted = amount ? Math.min(amount, claimable) : claimable;
    const before = await balanceIn(tx, userId);

    /*
      The grant's own lot first, then the user's other credits in spending order. Whatever they do
      not cover is the shortfall.
    */
    const sources = (await spendableLots(tx, userId)).sort((a, b) => (a.id === lot.id ? -1 : b.id === lot.id ? 1 : 0));
    const moves = [];
    let left = wanted;
    for(const source of sources){
      if(left <= 0) break;
      const take = Math.min(source.remaining, left);
      moves.push({ lotId: source.id, type: 'clawback', amount: -take });
      left -= take;
    }
    if(left > 0 && ifShort === 'owe') moves.push({ lotId: lot.id, type: 'shortfall', amount: -left });

    const operationId = newId('op');
    const reference = lot.referenceOwner ? { owner: lot.referenceOwner, ref: lot.referenceId } : null;
    const entries = await writeOperation(tx, {
      userId, operationId, key, reason: cleanReason, reference, reversesOperationId: lot.operationId, actorId, note: cleanNote, now,
    }, moves);

    /*
      Taking only what they hold: a zero-amount entry says "this grant is finished". It moves nothing,
      so every lot still equals the sum of its entries; it takes the idempotency key when nothing else
      did, so a retry is recognised even when the user held nothing at all.
    */
    if(left > 0 && ifShort === 'zero'){
      await tx.insert(kempoCreditEntry).values({
        id: newId('ent'),
        userId,
        lotId: lot.id,
        operationId,
        type: 'forfeit',
        amount: 0,
        reason: cleanReason,
        referenceOwner: reference?.owner ?? null,
        referenceId: reference?.ref ?? null,
        idempotencyKey: entries.length === 0 ? key : null,
        reversesOperationId: lot.operationId,
        actorId,
        note: cleanNote,
        createdAt: new Date(now.getTime() + entries.length),
      });
    }

    const [after] = await tx.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, lot.id));
    const balance = await balanceIn(tx, userId);
    const taken = sumOf(entries.filter(entry => entry.type === 'clawback'));

    return [null, {
      duplicate: false,
      operationId,
      lot: after,
      clawedBack: wanted,
      taken,
      fromOtherCredits: sumOf(entries.filter(entry => entry.type === 'clawback' && entry.lotId !== lot.id)),
      shortfall: ifShort === 'owe' ? left : 0,
      unrecovered: ifShort === 'zero' ? left : 0,
      owed: balance.owed,
      balance,
      before,
    }];
  }, { conflict: 'That claw back was already done' });

  if(error) return [error, null];

  const { before, ...clawed } = result;

  if(!clawed.duplicate){
    await fire('credits:clawed-back', {
      userId,
      operationId: clawed.operationId,
      lot: clawed.lot,
      taken: clawed.taken,
      shortfall: clawed.shortfall,
      unrecovered: clawed.unrecovered,
      owed: clawed.owed,
      balance: clawed.balance,
    });

    if(clawed.shortfall){
      await notifyAdmins({
        title: 'A user owes credits after a refund',
        message: `${clawed.clawedBack} credits were taken back but the user held only ${clawed.taken}, so they now owe ${clawed.owed} and cannot spend until that is covered or written off. Check whether this was a refund made outside the site, or a chargeback.`,
        dedupeKey: `shortfall:${userId}`,
        url: `/admin/extension/kempo-credits/account/?user=${encodeURIComponent(userId)}`,
      });
    }

    if(crossedLow(before, clawed.balance, config.lowBalanceThreshold)){
      await fire('credits:low', { userId, balance: clawed.balance, threshold: config.lowBalanceThreshold });
    }
  }

  return [null, clawed];
};
