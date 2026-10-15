/*
  Server-side entry point — what another extension imports to create, move and spend credits.

  ```js
  import { getBalance, grantCredits, spendCredits, transferCredits, reverseSpend } from 'kempo-credits/sdk';

  // Earn: an achievement, an ad watched, a purchase, a marketing signup — anything.
  await grantCredits({
    userId: player.id,
    amount: 50,
    kind: 'achievement',
    reason: 'achievement',
    reference: { owner: 'my-game', ref: `achievement:${achievement.id}:${player.id}` },
    idempotencyKey: `achievement:${achievement.id}:${player.id}`,
  });

  // Spend:
  const [error] = await spendCredits({
    userId: player.id,
    amount: 300,
    reason: 'boost',
    reference: { owner: 'my-game', ref: event.id },
    idempotencyKey: `boost:${event.id}`,
  });
  if(error?.code === 402){
    // not enough; error.balance and error.needed say how far short
  }

  // Trade or gift:
  await transferCredits({ fromUserId, toUserId, amount: 250, reason: 'trade', idempotencyKey: `trade:${trade.id}` });
  ```

  Every function returns `[error, data]` with `error = { code, msg }`, like the rest of kempo, and
  none of them throws. These are the *data* operations, with no permission checks of their own: the
  routes under public/api decide who may do what, and anything calling in here is server-side code
  that has already decided it is allowed. **There is no HTTP route that spends credits** — only the
  feature that is selling something knows what was bought, so spending is always that feature's own
  server code calling `spendCredits`.

  Credits do not know where they came from. Selling them, handing them out through links and
  rewarding players are separate extensions (or your own code) calling `grantCredits`.

  Hooks fired (notification mode, through kempo's triggerHook): `credits:granted`,
  `credits:spent`, `credits:reversed`, `credits:transferred`, `credits:clawed-back` and
  `credits:low`. See the README for their payloads.
*/

export { default as grantCredits } from './server/utils/ledger/grant.js';
export { default as spendCredits } from './server/utils/ledger/spend.js';
export { default as transferCredits } from './server/utils/ledger/transfer.js';
export { default as reverseSpend } from './server/utils/ledger/reverse.js';
export { clawBackGrant, getGrant, previewClawBack } from './server/utils/ledger/clawback.js';
export { removeCredits, forgiveDebt } from './server/utils/ledger/adjust.js';
export { getBalance, getLot, listLots, listEntries, getOperation, listAccounts, auditAccount, creditTotals } from './server/utils/ledger/read.js';
export { EVENTS } from './server/utils/ledger/events.js';
export { DEFAULT_KIND, MAX_AMOUNT } from './server/utils/ledger/validate.js';

export { readConfig, DEFAULTS, OWNER } from './server/utils/config/settings.js';
