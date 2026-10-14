# kempo-credits

An in-app currency for [kempo](https://github.com/dustinpoissant/kempo) sites. Users hold a **balance
of credits**; credits are **granted** — bought in packs, given as promotions, claimed from a link —
and **spent** on whatever the site sells for credits. Every change to a balance is an entry in an
append-only ledger, so any balance can be traced back to exactly how it came to be.

It knows nothing about what credits are spent *on*. That is the consumer's business: a feature calls
`spendCredits` with its own reference, and keeps its own record of what was bought.

- **Paid and promo credits are kept apart.** Bought credits are a prepaid balance; promo credits are
  a gift that may expire. Promo is spent first when both would expire together.
- **Safe to retry, safe under load.** Every operation takes an idempotency key, and two requests
  racing for the last credits cannot both get them.
- **Packs are bought through [kempo-payments](https://github.com/dustinpoissant/kempo-payments)**,
  with tax from [kempo-tax](https://github.com/dustinpoissant/kempo-tax) when it is installed, and
  credits are granted on the payment processor's word — never the browser's.
- **Card-testing protection** on the purchase flow: rate limits, a decline cool-down, and a log of
  every refused attempt.
- **Credits are never redeemable for money**, by anyone. See [Not in scope](#not-in-scope).

## Contents

- [Install](#install)
- [Concepts](#concepts)
- [Using credits from your own code](#using-credits-from-your-own-code)
- [SDK reference](#sdk-reference)
- [Hooks](#hooks)
- [Selling credits](#selling-credits)
- [Refunds, shortfalls and disputes](#refunds-shortfalls-and-disputes)
- [Abuse protection, and going live](#abuse-protection-and-going-live)
- [Components and pages](#components-and-pages)
- [HTTP API](#http-api)
- [Permissions and groups](#permissions-and-groups)
- [Settings](#settings)
- [Admin](#admin)
- [Not in scope](#not-in-scope)
- [Data](#data)
- [Development](#development)

## Install

```bash
npm install kempo-credits
```

Then install it from **Admin → Extensions**. It requires **kempo-payments** to be installed and
enabled first (kempo refuses otherwise), and uses **kempo-tax** if that is installed and enabled —
never otherwise, and nothing breaks without it.

Installing:

- creates the six tables and their indexes — including the unique index that makes retries safe;
  the install fails rather than going ahead without it;
- gives **`credits:purchase` to `system:Users`**, so every signed-in user can buy. This happens on
  the first install only: take it away to sell to a narrower group, and neither an update nor a
  reinstall gives it back;
- registers the hooks on kempo-payments' events, the **Credits** dashboard widget, and the admin
  screen under **Commerce**.

Nothing can be bought until there is a pack: add one under **Admin → Credits → Packs**.

## Concepts

| | |
|---|---|
| **Lot** | One grant of credits: how many, how many are left, `paid` or `promo`, an optional expiry, and where it came from. A balance is the sum of a user's live lots. |
| **Entry** | One immutable ledger row: a signed amount against a lot, with a reason, a `reference` and who did it. An operation that touches several lots writes one entry per lot, sharing an `operationId`. Entries are never updated or deleted. |
| **Pack** | Something to buy: this many credits for this much money, set by an administrator. |
| **Purchase** | One attempt to buy a pack: the pack as it was, the payment, the tax quote and, once paid, the lot it granted. Refused attempts are kept too — that is the abuse log. |
| **Claim link** | A token that grants promo credits to whoever redeems it, once per person, up to a limit. |

### Paid and promo

They are different things and stay different:

- **Paid** credits were bought. They are a prepaid balance the site owes its users, they are what a
  refund takes back, and they **never expire** unless the site turns on `paid_credits_expire` —
  which is off by default, with a warning beside it, because expiring a prepaid balance is restricted
  by consumer-protection and unclaimed-property law in many places. Take advice first.
- **Promo** credits were given away. They are not revenue, are not refundable as money, and may
  expire — on a fixed date or a number of days after the grant, whichever the grant says.

### Spending order

Credits are spent from the lot that **expires soonest**; when two expire together (or never),
**promo before paid**; after that, oldest first. A user never loses promo credits to expiry while
bought ones are drawn. Each spend's entries record which lots it drew from, so a reversal puts every
credit back where it came from.

### A balance can go below zero — once

Only one thing takes a balance negative: a **refund of credits that were already spent**. See
[Refunds, shortfalls and disputes](#refunds-shortfalls-and-disputes).

## Using credits from your own code

Everything is server-side, through the SDK. There is **no HTTP route that spends credits**: only the
feature that sells something knows what was bought, so it calls `spendCredits` from its own route.

```js
import { getBalance, spendCredits, reverseSpend, grantCredits } from 'kempo-credits/sdk';

// What does this user have?
const [, balance] = await getBalance({ userId });
// { total: 420, paid: 300, promo: 120, owed: 0, expiringSoon: 20, nextExpiresAt: Date }

// Charge them for something.
const [error, spent] = await spendCredits({
  userId,
  amount: 300,
  reason: 'boost',
  reference: { owner: 'crowd-pulse', ref: event.id },   // who is spending, and their id for what
  idempotencyKey: `boost:${event.id}`,                   // the same on a retry, new for a new spend
});

if(error?.code === 402){
  // Not enough. error.balance and error.needed say by how much — or error.owed, if a refund
  // left them owing and they cannot spend at all until that is covered.
}

// The thing they paid for fell through: give the credits back, to the lots they came from.
await reverseSpend({ userId, idempotencyKey: `boost:${event.id}` });

// Give credits. A monthly allowance is a grant whose key is the month, so running the job twice
// grants once.
await grantCredits({
  userId,
  amount: 100,
  kind: 'promo',
  expiresInDays: 31,
  reason: 'monthly',
  idempotencyKey: `monthly:${userId}:2026-10`,
});
```

**Idempotency keys** are the caller's to choose, and choosing them well is the point: the id of the
thing being paid for, the webhook's payment id, the request's own id — something that is the same on
the second attempt and different for the next real one. Sending the same key again returns the first
result with `duplicate: true`. Sending it with a different amount, or for a different kind of
operation, is a 409.

Every function returns `[error, data]` with `error = { code, msg }`, and none of them throws. They
are data operations with no permission checks: the routes decide who may call what.

## SDK reference

Imported from `kempo-credits/sdk`.

### The ledger

| Function | Does |
|---|---|
| `getBalance({ userId })` | `{ total, paid, promo, owed, expiringSoon, nextExpiresAt }`. `total` is what can be spent; it is below zero only when `owed` is not zero. |
| `grantCredits({ userId, amount, kind, expiresAt?, expiresInDays?, reason, reference?, idempotencyKey, actorId?, note? })` | Creates a lot and its entry. `kind` is `paid` or `promo`; paid credits take their expiry from the site's setting, never the caller. If the user owes credits, the grant pays that off first (`settled`). |
| `spendCredits({ userId, amount, reason, reference, idempotencyKey, actorId?, note? })` | Takes credits in spending order. **402** if short; never goes negative; never partly spends. |
| `reverseSpend({ userId, idempotencyKey, reason?, actorId?, note? })` | Returns what the spend under that key took, to the same lots. Credits returned to a lot that has expired since expire again (`expired` says how many). |
| `clawBackGrant({ lotId \| reference, amount?, reason?, idempotencyKey?, actorId?, note? })` | Takes back a grant, or `amount` of it. What was already spent becomes a **shortfall**; see below. Reports `taken`, `shortfall`, `settled`, `owed`. |
| `removeCredits({ userId, amount, note, idempotencyKey, actorId? })` | An administrator taking credits away, in spending order, never more than they have. |
| `forgiveDebt({ userId, amount?, note, idempotencyKey, actorId? })` | Writes off what a user owes — all of it, or `amount`. |
| `listEntries({ userId, type?, reference?, limit?, offset? })` | The ledger, newest first. |
| `listLots({ userId })`, `getLot({ lotId })`, `getOperation({ operationId })` | Reads. |
| `listAccounts({ search?, owing?, limit?, offset? })`, `creditTotals()` | Balances across users, and site-wide totals. |
| `auditAccount({ userId })` | Proves a balance from the ledger: every lot's `remaining` equals the sum of its entries. `{ ok, problems }`. |
| `expireLots()` | Writes off expired lots for everybody, as `expiry` entries. Balances are right without it; it brings the ledger in line, for a scheduled job. |

### Packs, purchases and claim links

| Function | Does |
|---|---|
| `listPacks({ enabledOnly? })`, `getPack`, `createPack`, `updatePack`, `deletePack` | The packs for sale. A pack that has been bought can be disabled, not deleted. |
| `startPurchase({ userId, packId, address?, ip?, userAgent?, email? })` | Prices the pack (with tax if kempo-tax is on), checks the abuse limits, records what the buyer is shown, and opens a payment. Returns `{ purchase, clientSecret, shown }`. |
| `getPurchase`, `listPurchases`, `purchaseSummary` | Reads. |
| `reconcilePurchase({ purchaseId })` | Asks the processor about a purchase's payment and applies the answer — for a webhook that never came. Idempotent. |
| `createClaim({ name?, amount, lotExpiresAt? \| lotExpiresInDays?, expiresAt? \| expiresInDays?, maxRedemptions? })` | Makes a claim link. The token is returned **once**; only its hash is stored. |
| `previewClaim({ token, userId? })`, `redeemClaim({ token, userId })`, `listClaims`, `setClaimEnabled` | |

## Hooks

Fired through kempo's `triggerHook`, in notification mode, after the change is committed. Register
handlers in your own `kempo-config.json`:

```json
"hooks": {
  "credits:low": "./hooks/credits-low.js"
}
```

| Event | Data | When |
|---|---|---|
| `credits:granted` | `{ userId, operationId, lot, amount, kind, reason, reference, settled, balance }` | credits were added — bought, given or claimed |
| `credits:spent` | `{ userId, operationId, amount, reason, reference, entries, balance }` | credits were spent |
| `credits:reversed` | `{ userId, operationId, reversedOperationId, amount, reference, balance }` | a spend was undone |
| `credits:clawed-back` | `{ userId, operationId, lot, taken, shortfall, settled, owed, balance }` | a grant was taken back, usually by a refund |
| `credits:low` | `{ userId, balance, threshold }` | the balance dropped below `low_balance_threshold` — once per crossing |

Each fires once per operation: a retry under the same key fires nothing.

## Selling credits

1. The buyer chooses a pack. The browser names a **pack, never an amount**: the server prices it.
2. If kempo-tax is installed and enabled, the price goes through `calculateTax` as one line of the
   `tax_class` setting (`digital` by default), with the buyer's billing address, and the result is
   what is charged. Whether tax is added on top or already inside the price is kempo-tax's
   `prices_include_tax`; either works. A tax calculation that fails stops the purchase rather than
   charging no tax.
3. The purchase records exactly what the buyer is shown before paying — the pack, price, tax, total
   and the refund policy — and kempo-payments opens a payment for that total, with
   `owner: 'kempo-credits'` and `reference: purchaseId`.
4. The buyer pays in kempo-payments' card form. When the browser says it went through, the page asks
   the server to check — and the server asks the processor.
5. **Credits are granted when kempo-payments fires `payment:succeeded`** — from Stripe's signed
   webhook, or from asking Stripe directly — never on the browser's word. The grant is idempotent on
   the payment id, so a webhook delivered twice grants once. The sale is then recorded with
   kempo-tax's `recordTransaction`.

A buyer starting a second purchase abandons the first: one still waiting for a card is cancelled at
the processor, so there is only ever one open payment per buyer to try cards against.

## Refunds, shortfalls and disputes

A refund made anywhere — kempo-payments' admin or Stripe's dashboard — reaches this extension as
kempo-payments' `payment:refunded`. The credits taken back are the refunded **share** of the pack,
rounded up (refund half the money, lose half the credits), worked out from the payment's running
total so partial refunds add up to exactly the pack. The tax is reversed with kempo-tax.

If some of those credits were already **spent**, they cannot be taken back. That part is the
**shortfall**:

- it is recorded as a `shortfall` entry that takes the lot, and the balance, below zero;
- it is paid off straight away from any other credits the user holds;
- whatever is still owed **blocks spending** until it is covered — by credits the user is granted
  later (a purchase, a promo, which pay off the debt first) or by an administrator writing it off;
- it fires `credits:clawed-back` with the figures, and **every user with `credits:view` is
  notified**, so nothing about it is silent.

Without that, buying credits, spending them and refunding the payment would be a way to keep what was
spent for free.

**Disputes are not refunds.** A chargeback flags the purchase and notifies the administrators; nothing
is taken back automatically, because the site may win it. **Claw back** on the purchase does it in
one click if they decide to.

## Abuse protection, and going live

The smallest pack is cheap and most buyers are strangers, which is what *card testing* looks for:
running stolen card numbers through a small checkout to see which work. It costs the site a fee per
attempt and, at worst, its Stripe account. So, before a purchase reaches the processor:

- **Rate limits** per account, per IP address and for the whole site, counted over the last hour
  (`purchase_limit_*`). The defaults are well above what a real buyer does.
- **A decline cool-down.** After `failed_payment_limit` declines (default 3) from one account or one
  address within `failed_payment_cooldown_minutes`, further attempts are refused until it has passed.
  The payment that hit the limit is also **cancelled at the processor**, so no more cards can be tried
  against it from the browser. One decline and a retry is a customer, and works.
- **Signed-in buyers only**, and only for an amount the server priced, for a pack that is on sale.
- **A log of every refused attempt** — Admin → Credits → Purchases → *Blocked attempts* — and a
  notification to administrators as the hour's count reaches 1, 10, 100…

Counting declines needs **kempo-payments 0.1.10 or later**, which reports every decline; earlier
versions report only declines whose message changed, so repeated identical declines are under-counted.

Behind a proxy or load balancer, turn on **`trust_proxy`** — otherwise every buyer arrives from the
proxy's address and shares one per-address limit. Leave it off when there is no proxy: the header can
then be anything the client likes.

### Before taking real money

- **Stripe Radar.** Every Stripe account has Radar's machine-learning screening, which blocks the
  payments it scores as highest risk by default — leave that on. With *Radar for Fraud Teams*, add
  rules that block failed security-code and postal-code checks and that cap attempts per card and per
  IP, for example `Block if :cvc_check: = 'fail'`. Check the exact rule syntax in Stripe's Radar
  documentation for your account.
- **Webhooks.** kempo-payments' settings screen lists the events its endpoint needs. This extension
  relies on `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`,
  `charge.refunded` and the dispute events reaching it.
- **A refund policy.** Write one into `refund_policy`. It is shown beside the total at checkout and
  recorded with every purchase, which is what answers a dispute.

## Components and pages

Two pages are served at the extension's own scope, in the site's default template:

- **`/credits/`** — the signed-in user's balance, the packs to buy, and their history.
- **`/credits/claim?token=…`** — where a claim link lands. It shows what the link is worth before the
  visitor signs in.

The components they are built from can go on any page:

```html
<script type="module" src="/credits/components/Balance.js"></script>
<k-cred-balance></k-cred-balance>
<k-cred-balance compact></k-cred-balance>   <!-- just the number, for a header -->
```

| Element | Module | |
|---|---|---|
| `<k-cred-balance>` | `/credits/components/Balance.js` | The signed-in user's balance. `refresh()` re-reads it. |
| `<k-cred-buy>` | `/credits/components/BuyCredits.js` | Choose a pack, see the total and refund policy, pay, wait for confirmation. Fires `credits-purchased` once the credits have actually been added. **Light DOM**: it hosts kempo-payments' card form, whose Stripe fields do not mount inside a shadow root, so nothing above it may be one either. |
| `<k-cred-history>` | `/credits/components/History.js` | The signed-in user's ledger. `refresh()` re-reads it. |
| `<k-cred-claim>` | `/credits/components/ClaimCredits.js` | Redeems a claim link; the token is its `token` attribute or the page's `?token=`. |
| `<k-cred-widget>` | `/credits/components/CreditsWidget.js` | The admin dashboard widget. |

A browser client is at `/credits/sdk.js`, returning the same `[error, data]` tuples — `getMyBalance`,
`listMyEntries`, `startPurchase`, `checkPurchase`, `redeemClaim` and the administrative calls. An
error carries what the route sent with it: `balance` and `needed` on a 402, `retryAfter` on a 429.

## HTTP API

All under `/credits/api`. Routes under `/my/` are about the signed-in user only: they need a session
and nothing else, and the user always comes from the session, never the request.

| Route | Who |
|---|---|
| `GET /packs`, `GET /checkout`, `GET /claims/preview?token=` | anyone |
| `GET /my/balance`, `GET /my/entries`, `GET /my/purchases`, `GET /my/purchases/:id`, `POST /my/purchases/:id/check`, `POST /claims/redeem` | signed in |
| `POST /my/purchases` `{ packId, address? }` | `credits:purchase` |
| `GET /accounts`, `GET /accounts/:userId`, `GET /accounts/:userId/entries`, `GET /purchases`, `GET /purchases/:id`, `POST /purchases/:id/reconcile`, `GET /summary` | `credits:view` |
| `POST /accounts/:userId/grant`, `GET /claims`, `POST /claims`, `PUT /claims/:id` | `credits:grant` |
| `POST /accounts/:userId/remove`, `POST /accounts/:userId/forgive`, `POST /lots/:id/claw-back`, `POST /operations/:id/reverse` | `credits:adjust` |
| `GET /packs?all=1`, `POST /packs`, `PUT /packs/:id`, `DELETE /packs/:id` | `credits:packs` |
| `GET /settings`, `PUT /settings` | `credits:settings` |

Administrative writes take an `idempotencyKey` in the body; the admin screens make one per form, so a
double click applies once. Each needs a `note`, which the ledger keeps.

## Permissions and groups

| Permission | Lets you |
|---|---|
| `credits:view` | See every balance and ledger, the purchases and the blocked-attempt log |
| `credits:grant` | Give promo credits, and make and manage claim links |
| `credits:adjust` | Take credits away, reverse a spend, claw back a grant, write off what is owed |
| `credits:packs` | Create, price and disable packs |
| `credits:settings` | Change the settings below |
| `credits:purchase` | Buy packs for yourself — held by `system:Users` from the first install |

| Group | Has |
|---|---|
| `kempo-credits:support` | admin access, `credits:view`, `credits:grant` — look anybody up and give goodwill credits |
| `kempo-credits:administrator` | admin access and everything above except `credits:purchase` |

## Settings

| Setting | Default | |
|---|---|---|
| `refund_policy` | *Credits have no cash value…* | Shown at checkout and recorded with each purchase. Say whether unspent credits can be refunded. |
| `tax_class` | `digital` | The kempo-tax class a pack is taxed as. |
| `low_balance_threshold` | `0` | Fires `credits:low` below this. 0 is off. |
| `expiring_soon_days` | `14` | How far ahead `expiringSoon` looks. |
| `paid_credits_expire` | `false` | Whether bought credits expire. **Take advice first.** |
| `paid_credits_expiry_days` | `365` | When they do, how long after the purchase. |
| `purchase_limit_per_user` | `10` | Purchase attempts per account per hour. |
| `purchase_limit_per_ip` | `20` | …per IP address per hour. |
| `purchase_limit_global` | `500` | …for the whole site per hour. Raise it before a launch. |
| `failed_payment_limit` | `3` | Declines before the cool-down. |
| `failed_payment_cooldown_minutes` | `60` | How long the cool-down lasts. |
| `trust_proxy` | `false` | Take the buyer's address from X-Forwarded-For. Only behind your own proxy. |

## Admin

**Admin → Commerce → Credits**, one tab per job, each behind its own permission:

- **Balances** — find anybody; open one user to see their balance, every lot they were granted, every
  change since, and the audit line that proves the balance from the ledger. Give, remove, claw back,
  reverse and write off from there.
- **Give credits** — find a user and give them promo credits, seeing what they already have.
- **Purchases** — every purchase and every refused attempt; one purchase shows what the buyer was
  shown, the payment, and the credits it granted. *Check with the payment processor* fixes one whose
  webhook never came.
- **Packs**, **Claim links**, **Settings**.

## Not in scope

- **What credits buy.** Features, products, events — that is the consumer's table, tagged with a
  `reference`.
- **Cash value.** Credits are never redeemable for money, by anyone. That is what keeps them a
  closed-loop prepaid balance rather than stored value subject to money-transmission rules. There is
  no cash-out path, and one should not be added without the site owner deciding it deliberately.
- **Transfers between users.** Not built; an operation can already span lots, so a transfer is two
  users' entries under one `operationId` when it is wanted.
- **Subscriptions.** Recurring billing needs Stripe Billing in kempo-payments. A monthly *grant* is
  already one call — see the example above.
- **Tax rules.** kempo-tax decides; this calls it.
- **Minimum purchase and maximum balance limits.** Not built — an open question for the owner.

## Data

Six tables. Credits are integers; money is an integer in the currency's minor unit; nothing is a float.

| Table | |
|---|---|
| `kempoCreditLot` | One grant. `remaining` is the sum of its entries — checked by `auditAccount`. |
| `kempoCreditEntry` | The ledger. A **unique index on `(userId, idempotencyKey)`** makes retries apply once; the key is on an operation's first entry only. |
| `kempoCreditPack` | The packs. |
| `kempoCreditPurchase` | Purchases and refused attempts, with what the buyer was shown. |
| `kempoCreditClaim` | Claim links, by token hash. |
| `kempoCreditClaimRedemption` | Who redeemed which link; the primary key `claimId:userId` is one per person. |

**Concurrency.** Every operation on a user runs in one transaction holding a Postgres advisory lock
for that user, so two operations on the same user queue and the second sees the first's result. Lot
updates are conditional as well (`remaining + amount >= 0`) and the idempotency key is a unique
index, so neither guarantee rests on the lock alone. Operations on different users never wait.

## Development

```bash
npm install
npm run link:local        # optional: use the sibling kempo checkouts instead of registry copies
npm test                  # unit tier: in-memory Postgres (PGlite), nothing else needed
```

The **integration tier** runs everything on a real Postgres, which is where the concurrency suites
mean the most — PGlite is one connection, so its transactions take turns by construction — and where
the **browser suite** runs:

```bash
docker compose up -d      # a throwaway Postgres on port 5447
export DATABASE_URL=postgresql://kempo:kempo@localhost:5447/kempo_credits_test
npx drizzle-kit push --force
npx playwright install chromium
npm run test:integration
```

The browser suite builds a throwaway kempo site under `tests/.tmp-site`, starts its own server on a
random port, installs kempo-payments and this extension through kempo's own install route, and
drives Chromium with Playwright through every screen and the permission contract for every audience.
Screenshots land in `tests/.tmp-site/screens`. It stops its own server when it finishes.

To include buying with a real test card, give it Stripe **test** keys (live keys are refused):

```bash
STRIPE_TEST_SECRET_KEY=sk_test_… STRIPE_TEST_PUBLISHABLE_KEY=pk_test_… npm run test:integration
```

The suites refuse to run against a database whose name does not end in `_test`, because they empty
this extension's tables.
