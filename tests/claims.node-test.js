import { eq } from 'drizzle-orm';
import { kempoCreditClaim } from '../server/db/schema.js';
import { createClaim, listClaims, previewClaim, redeemClaim, setClaimEnabled } from '../server/utils/claims/store.js';
import { getBalance, listLots } from '../server/utils/ledger/read.js';
import { db, integrationTier } from './helpers/db.js';
import { freshUser, invariant, purge } from './helpers/ledger.js';

/*
  Claim links: made once, redeemed once per person, never past their limit.
*/

const DAY = 86400000;

export const beforeAll = purge;
export const afterAll = purge;

export default {
  'a claim link is shown once and stored only as a hash': async ({ pass, fail }) => {
    const [error, { claim, token }] = await createClaim({ name: 'Launch', amount: 100, expiresInDays: 30, createdBy: 'admin-1' });
    if(error) return fail(error.msg);
    if(token.length < 40) return fail('the token is short enough to guess');
    if('tokenHash' in claim) return fail('the hash was handed back');

    const [row] = await db.select().from(kempoCreditClaim).where(eq(kempoCreditClaim.id, claim.id));
    if(row.tokenHash === token || row.tokenHash.includes(token)) return fail('the token was stored');
    if(row.tokenHint !== token.slice(-4)) return fail('no hint to tell links apart');

    const [, listed] = await listClaims();
    if(listed.claims.some(item => 'tokenHash' in item)) return fail('the list hands back hashes');
    pass('');
  },

  'redeeming grants promo credits, which never expire': async ({ pass, fail }) => {
    const [, link] = await createClaim({ amount: 50, expiresInDays: 7 });
    const user = freshUser();

    const [error, redeemed] = await redeemClaim({ token: link.token, userId: user });
    if(error) return fail(error.msg);
    if(redeemed.lot.kind !== 'promo' || redeemed.lot.amount !== 50) return fail(`granted ${redeemed.lot.kind} ${redeemed.lot.amount}`);
    if('expiresAt' in redeemed.lot) return fail('the credits carry an expiry');

    const [, balance] = await getBalance({ userId: user });
    if(balance.promo !== 50 || balance.paid !== 0) return fail(`balance ${JSON.stringify(balance)}`);
    const problem = await invariant(user);
    if(problem) return fail(problem);
    pass('');
  },

  'nobody redeems the same link twice': async ({ pass, fail }) => {
    const [, { token }] = await createClaim({ amount: 25 });
    const user = freshUser();
    await redeemClaim({ token, userId: user });

    const [error] = await redeemClaim({ token, userId: user });
    if(error?.code !== 409) return fail(`the second redemption gave ${error?.code ?? 'success'}`);
    const [, lots] = await listLots({ userId: user });
    if(lots.length !== 1) return fail(`${lots.length} lots`);

    const [, preview] = await previewClaim({ token, userId: user });
    if(!preview.redeemed) return fail('the preview does not know it was redeemed');
    pass('');
  },

  'a link is never redeemed past its limit, even all at once': async ({ pass, fail }) => {
    const [, { claim, token }] = await createClaim({ amount: 10, maxRedemptions: 5 });
    const users = Array.from({ length: 12 }, freshUser);

    const results = await Promise.all(users.map(userId => redeemClaim({ token, userId })));
    const succeeded = results.filter(([error]) => !error).length;
    const usedUp = results.filter(([error]) => error?.code === 410).length;
    if(succeeded !== 5 || usedUp !== 7) return fail(`${succeeded} redeemed and ${usedUp} were told it is used up`);

    const [row] = await db.select().from(kempoCreditClaim).where(eq(kempoCreditClaim.id, claim.id));
    if(row.redemptions !== 5) return fail(`the claim counts ${row.redemptions}`);

    let granted = 0;
    for(const userId of users) granted += (await getBalance({ userId }))[1].total;
    if(granted !== 50) return fail(`${granted} credits went out`);
    pass(integrationTier ? 'on a real Postgres' : '');
  },

  'a link that is off, expired or used up says so': async ({ pass, fail }) => {
    const [, off] = await createClaim({ amount: 5 });
    await setClaimEnabled({ claimId: off.claim.id, enabled: false });
    const [offError] = await redeemClaim({ token: off.token, userId: freshUser() });
    if(offError?.code !== 410 || !offError.msg.includes('turned off')) return fail(`a disabled link: ${JSON.stringify(offError)}`);

    const [, old] = await createClaim({ amount: 5, expiresInDays: 1 });
    await db.update(kempoCreditClaim).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(kempoCreditClaim.id, old.claim.id));
    const [oldError] = await redeemClaim({ token: old.token, userId: freshUser() });
    if(oldError?.code !== 410 || !oldError.msg.includes('expired')) return fail(`an expired link: ${JSON.stringify(oldError)}`);

    const [, preview] = await previewClaim({ token: old.token });
    if(preview.available || !preview.reason) return fail('the preview calls an expired link available');

    const [unknown] = await redeemClaim({ token: 'x'.repeat(43), userId: freshUser() });
    if(unknown?.code !== 404) return fail(`an unknown token gave ${unknown?.code}`);
    const [anonymous] = await redeemClaim({ token: old.token });
    if(anonymous?.code !== 401) return fail(`no user gave ${anonymous?.code}`);
    pass('');
  },

  'a link cannot give credits that expire, though the link itself can stop working': async ({ pass, fail }) => {
    for(const extra of [{ lotExpiresInDays: 3 }, { lotExpiresAt: new Date(Date.now() + 5 * DAY) }]){
      const [error] = await createClaim({ amount: 5, ...extra });
      if(error?.code !== 400 || !/do not expire/.test(error.msg)) return fail(`${JSON.stringify(extra)} gave ${JSON.stringify(error)}`);
    }

    const [linkError, link] = await createClaim({ amount: 5, expiresInDays: 30 });
    if(linkError) return fail(`a link that stops working in 30 days was refused: ${linkError.msg}`);
    const days = (new Date(link.claim.expiresAt) - Date.now()) / DAY;
    if(days < 29.9 || days > 30.1) return fail(`the link stops working in ${days} days`);

    const [noAmount] = await createClaim({ amount: 0 });
    if(noAmount?.code !== 400) return fail('a zero-credit link was accepted');
    pass('');
  },
};
