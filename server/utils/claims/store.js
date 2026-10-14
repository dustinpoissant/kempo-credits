import crypto from 'crypto';
import { desc, eq, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoCreditClaim, kempoCreditClaimRedemption } from '../../db/schema.js';
import { OWNER } from '../config/settings.js';
import newId from '../ids.js';
import grantCredits from '../ledger/grant.js';
import { cleanAmount, cleanExpiry, cleanText, cleanUserId } from '../ledger/validate.js';
import { abort, withUserLocks } from '../ledger/transaction.js';

/*
  Claim links: a token an administrator makes that grants promo credits to whoever redeems it.

  ```js
  const [error, { claim, token }] = await createClaim({ amount: 100, maxRedemptions: 500, expiresInDays: 30 });  // the link, not the credits
  // share https://example.com/credits/claim?token=${token}
  const [redeemError, { balance }] = await redeemClaim({ token, userId });
  ```

  The token is 32 random bytes and only its hash is stored, so the link is shown once — when it is
  made — and a leaked database backup is not a way to mint credits.

  Each person can redeem a link once, and a link with a limit is never redeemed past it, however many
  people try at the same moment: a redemption locks the claim's row and counts inside that lock.
  A link can stop working on a date (`expiresAt` / `expiresInDays`); the credits it grants never
  expire, and a claim that asks for them to is refused.
*/

const hash = token => crypto.createHash('sha256').update(token).digest('hex');

const present = claim => {
  if(!claim) return claim;
  const { tokenHash, ...visible } = claim;
  return visible;
};

const optionalCount = (value, label, max) => {
  if(value === undefined || value === null || value === '') return [null, null];
  if(!Number.isSafeInteger(value) || value < 1 || value > max) return [{ code: 400, msg: `${label} must be a whole number from 1 to ${max}` }, null];
  return [null, value];
};

export const createClaim = async ({ name, amount, lotExpiresAt, lotExpiresInDays, expiresAt, expiresInDays, maxRedemptions, createdBy = null } = {}) => {
  if((lotExpiresAt !== undefined && lotExpiresAt !== null) || (lotExpiresInDays !== undefined && lotExpiresInDays !== null)){
    return [{ code: 400, msg: 'Credits do not expire, so a claim link cannot give credits that do' }, null];
  }

  const [nameError, cleanName] = cleanText(name, 'A name', { max: 100 });
  if(nameError) return [nameError, null];
  const [amountError] = cleanAmount(amount);
  if(amountError) return [amountError, null];

  const now = new Date();
  const [linkError, linkExpiry] = cleanExpiry({ expiresAt, expiresInDays }, now);
  if(linkError) return [{ ...linkError, msg: `The link’s expiry: ${linkError.msg.toLowerCase()}` }, null];

  const [maxError, max] = optionalCount(maxRedemptions, 'The redemption limit', 10000000);
  if(maxError) return [maxError, null];

  const token = crypto.randomBytes(32).toString('base64url');
  const claim = {
    id: newId('clm'),
    tokenHash: hash(token),
    tokenHint: token.slice(-4),
    name: cleanName,
    amount,
    expiresAt: linkExpiry,
    maxRedemptions: max,
    redemptions: 0,
    enabled: true,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.insert(kempoCreditClaim).values(claim);
    return [null, { claim: present(claim), token }];
  } catch {
    return [{ code: 500, msg: 'Could not save the claim link' }, null];
  }
};

export const listClaims = async ({ limit = 50, offset = 0 } = {}) => {
  try {
    const rows = await db.select().from(kempoCreditClaim)
      .orderBy(desc(kempoCreditClaim.createdAt))
      .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
      .offset(Math.max(0, Number(offset) || 0));
    const [{ total }] = await db.select({ total: sql`count(*)::int` }).from(kempoCreditClaim);
    return [null, { claims: rows.map(present), total }];
  } catch {
    return [{ code: 500, msg: 'Could not list claim links' }, null];
  }
};

/*
  Turning a link off is the only change there is. Its amount and expiry are what people were told
  when it was shared, so changing them afterwards would make the link mean something else.
*/
export const setClaimEnabled = async ({ claimId, enabled } = {}) => {
  if(typeof claimId !== 'string' || !claimId) return [{ code: 400, msg: 'A claim id is required' }, null];
  if(typeof enabled !== 'boolean') return [{ code: 400, msg: 'Enabled is true or false' }, null];

  try {
    const [row] = await db.update(kempoCreditClaim).set({ enabled, updatedAt: new Date() }).where(eq(kempoCreditClaim.id, claimId)).returning();
    return row ? [null, present(row)] : [{ code: 404, msg: 'No such claim link' }, null];
  } catch {
    return [{ code: 500, msg: 'Could not update the claim link' }, null];
  }
};

const findByToken = async token => {
  if(typeof token !== 'string' || token.length < 20 || token.length > 200) return [{ code: 404, msg: 'That claim link is not valid' }, null];

  try {
    const [claim] = await db.select().from(kempoCreditClaim).where(eq(kempoCreditClaim.tokenHash, hash(token))).limit(1);
    return claim ? [null, claim] : [{ code: 404, msg: 'That claim link is not valid' }, null];
  } catch {
    return [{ code: 500, msg: 'Could not look up the claim link' }, null];
  }
};

const unavailable = (claim, now) => {
  if(!claim.enabled) return 'This claim link has been turned off';
  if(claim.expiresAt && new Date(claim.expiresAt) <= now) return 'This claim link has expired';
  if(claim.maxRedemptions && claim.redemptions >= claim.maxRedemptions) return 'This claim link has been used up';
  return null;
};

/*
  What the claim page shows before somebody signs in to redeem: how much, until when, and whether it
  still works. Nothing about who made it or who has redeemed it.
*/
export const previewClaim = async ({ token, userId = null } = {}) => {
  const [error, claim] = await findByToken(token);
  if(error) return [error, null];

  let redeemed = false;
  if(userId){
    const [row] = await db.select().from(kempoCreditClaimRedemption).where(eq(kempoCreditClaimRedemption.id, `${claim.id}:${userId}`)).limit(1);
    redeemed = !!row;
  }

  return [null, {
    name: claim.name,
    amount: claim.amount,
    expiresAt: claim.expiresAt,
    available: !unavailable(claim, new Date()),
    reason: unavailable(claim, new Date()),
    redeemed,
  }];
};

export const redeemClaim = async ({ token, userId } = {}) => {
  const [userError, user] = cleanUserId(userId);
  if(userError) return [{ code: 401, msg: 'Sign in to claim these credits' }, null];

  const [findError, found] = await findByToken(token);
  if(findError) return [findError, null];

  const now = new Date();
  const redemptionId = `${found.id}:${user}`;

  /*
    The claim's row is locked for the count and the insert, so a limit of 100 is 100 however many
    people redeem at once. The grant itself happens after, under the user's own lock, with an
    idempotency key unique to this claim and person — a redemption recorded but not yet granted
    (the server stopped in between) is granted by simply redeeming again.
  */
  const [error, redemption] = await withUserLocks([user], async tx => {
    const [claim] = await tx.select().from(kempoCreditClaim).where(eq(kempoCreditClaim.id, found.id)).for('update');
    const [existing] = await tx.select().from(kempoCreditClaimRedemption).where(eq(kempoCreditClaimRedemption.id, redemptionId));
    if(existing) return [null, { claim, existing: true }];

    const problem = unavailable(claim, now);
    if(problem) abort(410, problem);

    await tx.update(kempoCreditClaim)
      .set({ redemptions: sql`${kempoCreditClaim.redemptions} + 1`, updatedAt: now })
      .where(eq(kempoCreditClaim.id, claim.id));
    await tx.insert(kempoCreditClaimRedemption).values({ id: redemptionId, claimId: claim.id, userId: user, lotId: 'pending', createdAt: now });
    return [null, { claim, existing: false }];
  }, { conflict: 'You have already claimed these credits' });
  if(error) return [error, null];

  const { claim } = redemption;
  const [grantError, granted] = await grantCredits({
    userId: user,
    amount: claim.amount,
    kind: 'promo',
    reason: 'claim',
    reference: { owner: OWNER, ref: claim.id },
    idempotencyKey: `claim:${claim.id}`,
  });
  if(grantError) return [grantError, null];

  if(redemption.existing && granted.duplicate){
    return [{ code: 409, msg: 'You have already claimed these credits', balance: granted.balance }, null];
  }

  await db.update(kempoCreditClaimRedemption).set({ lotId: granted.lot.id }).where(eq(kempoCreditClaimRedemption.id, redemptionId)).catch(() => {});

  return [null, { claim: present(claim), lot: granted.lot, amount: claim.amount, balance: granted.balance }];
};
