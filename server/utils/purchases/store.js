import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoCreditPurchase } from '../../db/schema.js';
import newId from '../ids.js';
import { hasNulByte } from '../ledger/validate.js';

/*
  Every read and write of purchase rows, and nothing else.
*/

/*
  `pending` is waiting for the buyer to pay. `paid` has been granted. `partially_refunded` and
  `refunded` have had credits clawed back. `failed` never reached the processor, `canceled` was
  abandoned or released there, and `blocked` was refused by an abuse limit — the processor was never
  asked, or was told to stop.
*/
export const STATUSES = ['pending', 'paid', 'partially_refunded', 'refunded', 'failed', 'canceled', 'blocked'];

export const insertPurchase = async values => {
  const now = new Date();
  const row = { id: newId('pur'), createdAt: now, updatedAt: now, ...values };

  try {
    await db.insert(kempoCreditPurchase).values(row);
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not record the purchase' }, null];
  }
};

export const updatePurchase = async (id, changes) => {
  try {
    const [row] = await db.update(kempoCreditPurchase)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(kempoCreditPurchase.id, id))
      .returning();
    return row ? [null, row] : [{ code: 404, msg: 'No such purchase' }, null];
  } catch {
    return [{ code: 500, msg: 'Could not update the purchase' }, null];
  }
};

export const getPurchase = async ({ purchaseId } = {}) => {
  if(typeof purchaseId !== 'string' || !purchaseId || purchaseId.length > 100) return [{ code: 400, msg: 'A purchase id is required' }, null];

  try {
    const [row] = await db.select().from(kempoCreditPurchase).where(eq(kempoCreditPurchase.id, purchaseId)).limit(1);
    return row ? [null, row] : [{ code: 404, msg: 'No such purchase' }, null];
  } catch {
    return [{ code: 500, msg: 'Could not load the purchase' }, null];
  }
};

export const listPurchases = async ({ userId, status, limit = 25, offset = 0 } = {}) => {
  if(hasNulByte(userId, status)) return [{ code: 400, msg: 'Filters cannot contain null characters' }, null];

  const conditions = [];
  if(userId) conditions.push(eq(kempoCreditPurchase.userId, userId));
  if(status) conditions.push(Array.isArray(status) ? inArray(kempoCreditPurchase.status, status) : eq(kempoCreditPurchase.status, status));
  const where = conditions.length ? and(...conditions) : undefined;

  const take = Math.min(100, Math.max(1, Number(limit) || 25));
  const skip = Math.max(0, Number(offset) || 0);

  try {
    const rows = await db.select().from(kempoCreditPurchase)
      .where(where)
      .orderBy(desc(kempoCreditPurchase.createdAt), desc(kempoCreditPurchase.id))
      .limit(take)
      .offset(skip);
    const [{ total }] = await db.select({ total: sql`count(*)::int` }).from(kempoCreditPurchase).where(where);
    return [null, { purchases: rows, total, limit: take, offset: skip }];
  } catch {
    return [{ code: 500, msg: 'Could not list purchases' }, null];
  }
};

/*
  What the buyer may see of their own purchase. Not the address it came from or the browser it used:
  those are kept for the abuse limits and an administrator, not handed back to whoever holds the id.
*/
export const presentForBuyer = purchase => ({
  id: purchase.id,
  status: purchase.status,
  packId: purchase.packId,
  packName: purchase.packName,
  credits: purchase.credits,
  currency: purchase.currency,
  subtotal: purchase.subtotal,
  tax: purchase.tax,
  total: purchase.total,
  includesTax: purchase.includesTax,
  refundedAmount: purchase.refundedAmount,
  creditsClawedBack: purchase.creditsClawedBack,
  lastError: purchase.lastError,
  shown: purchase.shown,
  paidAt: purchase.paidAt,
  refundedAt: purchase.refundedAt,
  createdAt: purchase.createdAt,
});

/*
  What the admin screen and the dashboard widget put across the top. Money is per currency, because
  adding two currencies together gives a number that looks right and is not.
*/
export const purchaseSummary = async ({ days = 30 } = {}) => {
  const since = new Date(Date.now() - days * 86400000);
  const lastDay = new Date(Date.now() - 86400000);

  try {
    const sales = await db.select({
      currency: kempoCreditPurchase.currency,
      count: sql`count(*)::int`,
      credits: sql`coalesce(sum(${kempoCreditPurchase.credits}), 0)::bigint`,
      total: sql`coalesce(sum(${kempoCreditPurchase.total}), 0)::bigint`,
      refunded: sql`coalesce(sum(${kempoCreditPurchase.refundedAmount}), 0)::bigint`,
    })
      .from(kempoCreditPurchase)
      .where(and(inArray(kempoCreditPurchase.status, ['paid', 'partially_refunded', 'refunded']), gte(kempoCreditPurchase.paidAt, since)))
      .groupBy(kempoCreditPurchase.currency);

    const [{ blocked }] = await db.select({ blocked: sql`count(*)::int` }).from(kempoCreditPurchase)
      .where(and(eq(kempoCreditPurchase.status, 'blocked'), gte(kempoCreditPurchase.createdAt, lastDay)));
    const [{ attention }] = await db.select({ attention: sql`count(*)::int` }).from(kempoCreditPurchase)
      .where(sql`${kempoCreditPurchase.disputed} or ${kempoCreditPurchase.shortfall} > 0 or ${kempoCreditPurchase.taxError} is not null`);

    return [null, {
      days,
      sales: sales.map(row => ({ ...row, credits: Number(row.credits), total: Number(row.total), refunded: Number(row.refunded) })),
      blockedLastDay: blocked,
      needsAttention: attention,
    }];
  } catch {
    return [{ code: 500, msg: 'Could not summarise purchases' }, null];
  }
};
