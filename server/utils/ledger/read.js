import { and, asc, desc, eq, gt, ilike, inArray, or, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { user } from 'kempo/server/db/schema.js';
import { kempoCreditEntry, kempoCreditLot } from '../../db/schema.js';
import { summarise } from './lots.js';
import { cleanUserId, hasNulByte } from './validate.js';

/*
  Reading the ledger. Nothing here writes.
*/

const page = (limit, offset, max = 200) => ({
  take: Math.min(max, Math.max(1, Number(limit) || 50)),
  skip: Math.max(0, Number(offset) || 0),
});

/*
  `{ total, paid, promo, owed }`. `total` is what can be spent, and is below zero only when the user
  owes credits from a refund that took back more than they held — `owed` says how many.
*/
export const getBalance = async ({ userId } = {}) => {
  const [userError, id] = cleanUserId(userId);
  if(userError) return [userError, null];

  try {
    const lots = await db.select().from(kempoCreditLot)
      .where(and(eq(kempoCreditLot.userId, id), sql`${kempoCreditLot.remaining} <> 0`));
    return [null, summarise(lots)];
  } catch {
    return [{ code: 500, msg: 'Could not load the balance' }, null];
  }
};

/*
  A lot, with what has happened to it.
*/
export const getLot = async ({ lotId } = {}) => {
  if(typeof lotId !== 'string' || !lotId) return [{ code: 400, msg: 'A lot id is required' }, null];

  try {
    const [lot] = await db.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, lotId)).limit(1);
    if(!lot) return [{ code: 404, msg: 'No such lot' }, null];
    const entries = await db.select().from(kempoCreditEntry)
      .where(eq(kempoCreditEntry.lotId, lotId))
      .orderBy(asc(kempoCreditEntry.createdAt), asc(kempoCreditEntry.id));
    return [null, { ...lot, entries }];
  } catch {
    return [{ code: 500, msg: 'Could not load the lot' }, null];
  }
};

export const listLots = async ({ userId, includeEmpty = true } = {}) => {
  const [userError, id] = cleanUserId(userId);
  if(userError) return [userError, null];

  try {
    const rows = await db.select().from(kempoCreditLot)
      .where(includeEmpty ? eq(kempoCreditLot.userId, id) : and(eq(kempoCreditLot.userId, id), sql`${kempoCreditLot.remaining} <> 0`))
      .orderBy(desc(kempoCreditLot.createdAt), desc(kempoCreditLot.id));
    return [null, rows];
  } catch {
    return [{ code: 500, msg: 'Could not load the lots' }, null];
  }
};

/*
  A user's ledger, newest first. Every way their balance has changed is in here, which is how a site
  answers "where did my credits go".
*/
export const listEntries = async ({ userId, type, reference, limit = 50, offset = 0 } = {}) => {
  const [userError, id] = cleanUserId(userId);
  if(userError) return [userError, null];
  if(hasNulByte(type, reference)) return [{ code: 400, msg: 'Filters cannot contain null characters' }, null];

  const conditions = [eq(kempoCreditEntry.userId, id)];
  if(type) conditions.push(Array.isArray(type) ? inArray(kempoCreditEntry.type, type) : eq(kempoCreditEntry.type, type));
  if(reference?.owner) conditions.push(eq(kempoCreditEntry.referenceOwner, reference.owner));
  if(reference?.ref) conditions.push(eq(kempoCreditEntry.referenceId, String(reference.ref)));

  const { take, skip } = page(limit, offset);

  try {
    const entries = await db.select({ entry: kempoCreditEntry, kind: kempoCreditLot.kind })
      .from(kempoCreditEntry)
      .leftJoin(kempoCreditLot, eq(kempoCreditLot.id, kempoCreditEntry.lotId))
      .where(and(...conditions))
      .orderBy(desc(kempoCreditEntry.createdAt), desc(kempoCreditEntry.id))
      .limit(take)
      .offset(skip);
    const [counted] = await db.select({ total: sql`count(*)::int` }).from(kempoCreditEntry).where(and(...conditions));
    return [null, { entries: entries.map(row => ({ ...row.entry, kind: row.kind })), total: counted?.total ?? 0, limit: take, offset: skip }];
  } catch {
    return [{ code: 500, msg: 'Could not load the ledger' }, null];
  }
};

export const getOperation = async ({ operationId } = {}) => {
  if(typeof operationId !== 'string' || !operationId) return [{ code: 400, msg: 'An operation id is required' }, null];

  try {
    const entries = await db.select().from(kempoCreditEntry)
      .where(eq(kempoCreditEntry.operationId, operationId))
      .orderBy(asc(kempoCreditEntry.createdAt), asc(kempoCreditEntry.id));
    if(!entries.length) return [{ code: 404, msg: 'No such operation' }, null];

    const key = entries.find(entry => entry.idempotencyKey)?.idempotencyKey || null;
    const [reversal] = await db.select({ operationId: kempoCreditEntry.operationId }).from(kempoCreditEntry)
      .where(eq(kempoCreditEntry.reversesOperationId, operationId))
      .limit(1);

    return [null, {
      operationId,
      userId: entries[0].userId,
      type: entries[0].type,
      idempotencyKey: key,
      amount: entries.reduce((sum, entry) => sum + entry.amount, 0),
      reversedBy: reversal?.operationId || null,
      entries,
    }];
  } catch {
    return [{ code: 500, msg: 'Could not load the operation' }, null];
  }
};

const likePattern = text => `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`;

/*
  Balances for the admin screen. With `search`, every user whose name or email matches — including
  ones who have never had a credit, because "find this person" is the question. Without it, the
  users who have a ledger at all, most recently active first. `owing` narrows to users who owe.
*/
export const listAccounts = async ({ search, owing = false, limit = 25, offset = 0 } = {}) => {
  if(hasNulByte(search)) return [{ code: 400, msg: 'Search cannot contain null characters' }, null];

  const totals = db.select({
    userId: kempoCreditLot.userId,
    total: sql`coalesce(sum(${kempoCreditLot.remaining}), 0)::bigint`.as('total'),
    paid: sql`coalesce(sum(${kempoCreditLot.remaining}) filter (where ${kempoCreditLot.kind} = 'paid'), 0)::bigint`.as('paid'),
    promo: sql`coalesce(sum(${kempoCreditLot.remaining}) filter (where ${kempoCreditLot.kind} = 'promo'), 0)::bigint`.as('promo'),
    owed: sql`coalesce(-sum(${kempoCreditLot.remaining}) filter (where ${kempoCreditLot.remaining} < 0), 0)::bigint`.as('owed'),
    lastActivity: sql`max(${kempoCreditLot.updatedAt})`.mapWith(kempoCreditLot.updatedAt).as('lastActivity'),
  }).from(kempoCreditLot).groupBy(kempoCreditLot.userId).as('totals');

  const fields = {
    userId: sql`coalesce(${user.id}, ${totals.userId})`,
    name: user.name,
    email: user.email,
    total: totals.total,
    paid: totals.paid,
    promo: totals.promo,
    owed: totals.owed,
    lastActivity: totals.lastActivity,
  };

  const { take, skip } = page(limit, offset, 100);
  const query = typeof search === 'string' ? search.trim() : '';

  try {
    let rows;
    let total;

    if(query){
      const where = or(ilike(user.email, likePattern(query)), ilike(user.name, likePattern(query)), eq(user.id, query));
      const filtered = owing ? and(where, gt(totals.owed, 0)) : where;
      rows = await db.select(fields).from(user).leftJoin(totals, eq(totals.userId, user.id))
        .where(filtered).orderBy(asc(user.email)).limit(take).offset(skip);
      [{ total }] = await db.select({ total: sql`count(*)::int` }).from(user).leftJoin(totals, eq(totals.userId, user.id)).where(filtered);
    } else {
      const filtered = owing ? gt(totals.owed, 0) : undefined;
      rows = await db.select(fields).from(totals).leftJoin(user, eq(user.id, totals.userId))
        .where(filtered).orderBy(desc(totals.lastActivity)).limit(take).offset(skip);
      [{ total }] = await db.select({ total: sql`count(*)::int` }).from(totals).where(filtered);
    }

    return [null, {
      accounts: rows.map(row => ({
        userId: row.userId,
        name: row.name || null,
        email: row.email || null,
        total: Number(row.total || 0),
        paid: Number(row.paid || 0),
        promo: Number(row.promo || 0),
        owed: Number(row.owed || 0),
        lastActivity: row.lastActivity || null,
      })),
      total,
      limit: take,
      offset: skip,
    }];
  } catch(error) {
    console.error(`[kempo-credits] Could not list accounts: ${error.message}`);
    return [{ code: 500, msg: 'Could not list balances' }, null];
  }
};

/*
  Credits across the whole site: how many users hold some, how many paid and promo credits are
  outstanding, and how many users owe and how much. Outstanding paid credits are a liability — a
  prepaid balance the site still has to honour — which is why they are reported apart.
*/
export const creditTotals = async () => {
  const held = sql`${kempoCreditLot.remaining} > 0`;

  try {
    const [row] = await db.select({
      holders: sql`count(distinct ${kempoCreditLot.userId}) filter (where ${held})::int`,
      paid: sql`coalesce(sum(${kempoCreditLot.remaining}) filter (where ${held} and ${kempoCreditLot.kind} = 'paid'), 0)::bigint`,
      promo: sql`coalesce(sum(${kempoCreditLot.remaining}) filter (where ${held} and ${kempoCreditLot.kind} = 'promo'), 0)::bigint`,
      owing: sql`count(distinct ${kempoCreditLot.userId}) filter (where ${kempoCreditLot.remaining} < 0)::int`,
      owed: sql`coalesce(-sum(${kempoCreditLot.remaining}) filter (where ${kempoCreditLot.remaining} < 0), 0)::bigint`,
    }).from(kempoCreditLot);

    return [null, {
      holders: row?.holders ?? 0,
      paid: Number(row?.paid || 0),
      promo: Number(row?.promo || 0),
      owing: row?.owing ?? 0,
      owed: Number(row?.owed || 0),
    }];
  } catch {
    return [{ code: 500, msg: 'Could not total the credits' }, null];
  }
};

/*
  Proves a user's balance from their ledger: every lot's `remaining` must equal the sum of its
  entries, every lot must have been opened by a grant of exactly its amount, and every entry must
  belong to a lot of this user's. Anything else is listed in `problems`. It reads only, and an empty
  list is the answer an administrator wants to be able to show somebody.
*/
export const auditAccount = async ({ userId } = {}) => {
  const [userError, id] = cleanUserId(userId);
  if(userError) return [userError, null];

  try {
    const lots = await db.select().from(kempoCreditLot).where(eq(kempoCreditLot.userId, id));
    const entries = await db.select().from(kempoCreditEntry).where(eq(kempoCreditEntry.userId, id));
    const byLot = new Map(lots.map(lot => [lot.id, { lot, sum: 0, grants: [] }]));
    const problems = [];

    for(const entry of entries){
      const tally = byLot.get(entry.lotId);
      if(!tally){
        problems.push(`entry ${entry.id} is against lot ${entry.lotId}, which is not one of this user's`);
        continue;
      }
      tally.sum += entry.amount;
      if(entry.type === 'grant') tally.grants.push(entry);
    }

    for(const { lot, sum, grants } of byLot.values()){
      if(lot.remaining !== sum) problems.push(`lot ${lot.id} says ${lot.remaining} remain, but its entries add up to ${sum}`);
      if(grants.length !== 1 || grants[0].amount !== lot.amount){
        problems.push(`lot ${lot.id} was granted ${lot.amount}, but its grant entries say ${grants.map(grant => grant.amount).join(', ') || 'nothing'}`);
      }
    }

    const balance = summarise(lots);
    return [null, { ok: !problems.length, lots: lots.length, entries: entries.length, balance, problems }];
  } catch {
    return [{ code: 500, msg: 'Could not audit the account' }, null];
  }
};
