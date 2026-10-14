/*
  Server-side entry point — what another extension imports to use credits.

  ```js
  import { getBalance, spendCredits, reverseSpend } from 'kempo-credits/sdk';

  const [error, spent] = await spendCredits({
    userId: user.id,
    amount: 300,
    reason: 'boost',
    reference: { owner: 'crowd-pulse', ref: event.id },
    idempotencyKey: `boost:${event.id}`,
  });
  if(error?.code === 402){
    // not enough credits; error.balance and error.needed say how far short
  }
  ```

  Every function returns `[error, data]` with `error = { code, msg }`, like the rest of kempo, and
  none of them throws. These are the *data* operations, with no permission checks of their own: the
  routes under public/api decide who may do what, and anything calling in here is server-side code
  that has already decided it is allowed. **There is no HTTP route that spends credits** — only the
  feature that is selling something knows what was bought, so spending is always that feature's own
  server code calling `spendCredits`.

  Hooks fired (notification mode, through kempo's triggerHook): `credits:granted`, `credits:spent`,
  `credits:reversed`, `credits:clawed-back` and `credits:low`. See the README for their payloads.
*/

export { default as grantCredits } from './server/utils/ledger/grant.js';
export { default as spendCredits } from './server/utils/ledger/spend.js';
export { default as reverseSpend } from './server/utils/ledger/reverse.js';
export { default as clawBackGrant } from './server/utils/ledger/clawback.js';
export { removeCredits, forgiveDebt } from './server/utils/ledger/adjust.js';
export { getBalance, getLot, listLots, listEntries, getOperation, listAccounts, auditAccount, creditTotals, expireLots } from './server/utils/ledger/read.js';
export { EVENTS } from './server/utils/ledger/events.js';
export { KINDS, MAX_AMOUNT } from './server/utils/ledger/validate.js';

export { listPacks, getPack, createPack, updatePack, deletePack } from './server/utils/packs/store.js';

export { default as startPurchase } from './server/utils/purchases/start.js';
export { getPurchase, listPurchases, purchaseSummary, presentForBuyer, STATUSES as PURCHASE_STATUSES } from './server/utils/purchases/store.js';
export { reconcilePurchase, checkPurchase, creditsForRefund } from './server/utils/purchases/payments.js';
export { checkLimits } from './server/utils/purchases/limits.js';
export { taxModule, priceFor } from './server/utils/purchases/tax.js';

export { createClaim, listClaims, setClaimEnabled, previewClaim, redeemClaim } from './server/utils/claims/store.js';

export { readConfig, DEFAULTS, OWNER } from './server/utils/config/settings.js';
