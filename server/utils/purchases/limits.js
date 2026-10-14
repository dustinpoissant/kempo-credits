import { and, eq, gte, ne, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoCreditPurchase } from '../../db/schema.js';
import { notifyAdmins } from '../ledger/events.js';
import { insertPurchase } from './store.js';

/*
  Card testing, and what stands in its way.

  The smallest pack is cheap and most buyers are strangers, which is exactly the checkout somebody
  with a list of stolen card numbers looks for: run each one through a $0.99 purchase and see which
  still work. Every attempt costs the site a processor fee, and enough of them cost it the processor
  account. So before a purchase reaches the processor it has to get past:

  - **Rate limits**, per user, per IP address and for the whole site, counted over the last hour.
    The defaults are well above what a real buyer does — a handful of attempts — and the site-wide
    one is a ceiling for an attack spread across many accounts and addresses.
  - **A decline cool-down.** Once a user or an address has had `failed_payment_limit` payments
    declined within the cool-down, further attempts are refused until it has passed. One decline and
    a retry is a person who mistyped; three is a list being worked through.

  Everything is counted from the purchase rows themselves, so the limits survive a restart and hold
  across several server processes. Attempts that were themselves refused are not counted: an
  attacker hammering a refused route would otherwise keep the site-wide count high and lock out
  everyone else.

  The limits are checked, then the attempt is recorded, without a lock between: two attempts in the
  same millisecond can both get in at the edge of a limit. That is fine for a rate limit, whose job
  is to make an attack slow and visible rather than to count exactly.
*/

const HOUR = 3600000;

/*
  A timestamp aggregated in raw SQL skips the column's own decoding, and comes back as a bare
  "2026-10-13 22:00:00" that JavaScript reads as local time — hours out on any server not on UTC.
  `mapWith` puts the column's decoding back.
*/
const count = async where => {
  const [row] = await db.select({
    count: sql`count(*)::int`,
    oldest: sql`min(${kempoCreditPurchase.createdAt})`.mapWith(kempoCreditPurchase.createdAt),
  }).from(kempoCreditPurchase).where(where);
  return { count: row?.count ?? 0, oldest: row?.oldest || null };
};

const declines = async where => {
  const [row] = await db.select({
    count: sql`coalesce(sum(${kempoCreditPurchase.failures}), 0)::int`,
    latest: sql`max(${kempoCreditPurchase.lastFailedAt})`.mapWith(kempoCreditPurchase.lastFailedAt),
  }).from(kempoCreditPurchase).where(where);
  return { count: row?.count ?? 0, latest: row?.latest || null };
};

const seconds = (at, now) => Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000));

export const REASONS = {
  'user-rate': 'Too many purchase attempts from this account in the last hour',
  'ip-rate': 'Too many purchase attempts from this network in the last hour',
  'global-rate': 'The shop is taking too many purchases at once',
  'user-declines': 'Too many declined payments on this account',
  'ip-declines': 'Too many declined payments from this network',
};

/*
  Null when the attempt may go ahead, or `{ reason, retryAfter }` — the reason one of REASONS'
  keys, and `retryAfter` in seconds.
*/
export const checkLimits = async ({ userId, ip, config, now = new Date() }) => {
  const hourAgo = new Date(now.getTime() - HOUR);
  const cooldown = config.failedPaymentCooldownMinutes * 60000;
  const cooldownStart = new Date(now.getTime() - cooldown);
  const counted = ne(kempoCreditPurchase.status, 'blocked');

  try {
    const userDeclines = await declines(and(eq(kempoCreditPurchase.userId, userId), gte(kempoCreditPurchase.lastFailedAt, cooldownStart)));
    if(userDeclines.count >= config.failedPaymentLimit){
      return [null, { reason: 'user-declines', retryAfter: seconds(new Date(userDeclines.latest.getTime() + cooldown), now) }];
    }

    if(ip){
      const ipDeclines = await declines(and(eq(kempoCreditPurchase.ip, ip), gte(kempoCreditPurchase.lastFailedAt, cooldownStart)));
      if(ipDeclines.count >= config.failedPaymentLimit){
        return [null, { reason: 'ip-declines', retryAfter: seconds(new Date(ipDeclines.latest.getTime() + cooldown), now) }];
      }
    }

    const user = await count(and(eq(kempoCreditPurchase.userId, userId), gte(kempoCreditPurchase.createdAt, hourAgo), counted));
    if(user.count >= config.purchaseLimitPerUser){
      return [null, { reason: 'user-rate', retryAfter: seconds(new Date(user.oldest.getTime() + HOUR), now) }];
    }

    if(ip){
      const network = await count(and(eq(kempoCreditPurchase.ip, ip), gte(kempoCreditPurchase.createdAt, hourAgo), counted));
      if(network.count >= config.purchaseLimitPerIp){
        return [null, { reason: 'ip-rate', retryAfter: seconds(new Date(network.oldest.getTime() + HOUR), now) }];
      }
    }

    const site = await count(and(gte(kempoCreditPurchase.createdAt, hourAgo), counted));
    if(site.count >= config.purchaseLimitGlobal){
      return [null, { reason: 'global-rate', retryAfter: seconds(new Date(site.oldest.getTime() + HOUR), now) }];
    }

    return [null, null];
  } catch {
    return [{ code: 500, msg: 'Could not check the purchase limits' }, null];
  }
};

/*
  Writes the refused attempt to the log administrators read, and tells them — but only as the
  hour's count reaches 1, 10, 100, 1000: one notification that an attack has started and one each
  time it gets an order of magnitude worse, rather than a write to every administrator per attempt.
*/
export const recordBlocked = async ({ userId, packId = null, ip = null, userAgent = null, reason, now = new Date() }) => {
  const [error, purchase] = await insertPurchase({
    userId,
    status: 'blocked',
    packId,
    ip,
    userAgent,
    blockedReason: reason,
    createdAt: now,
    updatedAt: now,
  });
  if(error) return [error, null];

  try {
    const [{ blocked }] = await db.select({ blocked: sql`count(*)::int` }).from(kempoCreditPurchase)
      .where(and(eq(kempoCreditPurchase.status, 'blocked'), gte(kempoCreditPurchase.createdAt, new Date(now.getTime() - HOUR))));
    if([1, 10, 100, 1000, 10000].includes(blocked)){
      await notifyAdmins({
        title: blocked === 1 ? 'A credit purchase was refused' : `${blocked} credit purchases refused in the last hour`,
        message: `${REASONS[reason] || reason}. ${blocked > 1 ? 'This many refusals is what card testing looks like — check the blocked attempts and the processor’s fraud tools.' : 'Usually a person retrying too often; more of these is worth a look.'}`,
        dedupeKey: 'blocked-purchases',
        url: '/admin/extension/kempo-credits/?tab=purchases&status=blocked',
      });
    }
  } catch {
    // The attempt is logged; failing to notify about it does not un-refuse it.
  }

  return [null, purchase];
};
