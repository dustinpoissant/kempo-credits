# kempo-credits — PLAN

> Status: **planned, nothing built.** This file is the brief. An agent picking this up should build
> exactly what it describes, and raise anything it disagrees with here rather than improvising.

> **Upstream changes are allowed.** Every dependency with `kempo` in its name (kempo, kempo-ui,
> kempo-css, kempo-server, kempo-payments, kempo-media, and the rest) is owned by the same person, and
> the goal of this project is to keep improving all of them. If the work here needs a change in one of
> them — a UI component, a payment call, a CMS hook — **make it, in that repository, without asking
> and without deferring it to a later step.** Do it the normal way there: tests, README and CHANGELOG,
> a backwards-compatible change where other packages depend on it, and the dependency order when
> publishing. Never commit a `file:` specifier.

## What it is

An in-app currency for kempo sites: users hold a **balance of credits**, credits are **granted**
(bought, promotional, awarded) and **spent**, and every change is an entry in an append-only
ledger. It knows nothing about what credits are spent *on*.

## Why it exists

The first consumer is [crowd-pulse.app](../crowd-pulse.app/PLAN.md), where almost every feature costs
$1–5 and card processing costs about 3% + $0.30 per charge — so selling features one at a time would
lose a third of every sale to fees. Credits let a user pay once for a bulk pack and spend it in
small pieces.

It is a separate extension, not part of Crowd Pulse, because it passes the test every kempo
extension has to: *would anything other than this app use it on its own?* Any site with points,
tokens, usage billing, a loyalty scheme or a prepaid wallet needs exactly this ledger.

## Not in scope

- **What credits buy.** Features, products, events — that is the consumer's table, tagged with a
  `reference`. This extension has no concept of an event or a product.
- **Cash value.** Credits are never redeemable for money, by anyone. That is what keeps them a
  closed-loop prepaid balance rather than stored value subject to money-transmission rules. Do not
  build a cash-out path, and do not let one be added without the owner deciding it deliberately.
- **Transfers between users** (v1). The ledger should not make them impossible later.
- **Subscriptions** (v1). Recurring billing needs Stripe Billing in kempo-payments, which does not
  exist. The ledger must make a monthly grant trivial to add, nothing more.
- **Tax rules.** It calls kempo-tax; it does not decide anything about tax.

## Concepts

- **Lot** — one grant of credits: amount, what is left, kind (`paid` or `promo`), optional expiry,
  where it came from. A balance is the sum of a user's unexpired lots.
- **Entry** — one immutable ledger row: a signed amount against a lot, with a reason, a `reference`
  (`{ owner, ref }` — who asked and their id for it) and an idempotency key. Entries are never
  updated or deleted.
- **Pack** — a purchasable amount of credits at a price, defined by an administrator.
- **Purchase** — one attempt to buy a pack: ties a pack, a payment, a tax quote and, once paid, a
  grant together.
- **Claim link** — a token an administrator creates that grants promo credits to whoever redeems it.

### Spending order

Spend from the lot that **expires soonest**, and from **promo before paid** when equal. A user must
never lose promo credits to expiry while paid ones are drawn first. The entries record which lots
were consumed, so a reversal returns credits to the lot they came from.

### Paid versus promo

Kept apart because they are different things: promo credits are not revenue, may expire, and are not
refundable as money. A paid lot **never expires by default** — expiring prepaid balances has
consumer-protection and unclaimed-property implications that the site owner must choose to accept,
so it is a setting, off, with that warning beside it.

## Data

Tables: `kempoCreditLot`, `kempoCreditEntry`, `kempoCreditPack`, `kempoCreditPurchase`,
`kempoCreditClaim`, `kempoCreditClaimRedemption`.

- Money is always an integer in the currency's minor unit, as in kempo-payments. Credits are
  integers too. No floats anywhere.
- A **unique index on `(userId, idempotencyKey)`** in `kempoCreditEntry` is a correctness guarantee,
  not an optimisation: it is what makes a retried request or a webhook delivered twice grant once.
  kempo's installer does not carry indexes across from the Drizzle schema, so create it by hand in
  `install.js` the way kempo-payments does, and add a test that the schema and `install.js` agree.
- Spending must be safe under concurrency. Two simultaneous spends of the last 100 credits must
  result in exactly one success. Use a row lock or a conditional update inside a transaction, and
  **write a test that fires them in parallel.**
- A balance can be derived from lots at any time; if a cached balance column is kept for speed it is
  a cache, and a test must prove it equals the sum of the lots after every operation.

## SDK (server side, `kempo-credits/sdk`)

All return `[error, data]` with `error = { code, msg }`, like the rest of kempo. These are data
operations with no permission checks; the HTTP routes enforce who may do what.

| Function | Does |
|---|---|
| `getBalance({ userId })` | `{ total, paid, promo, expiringSoon }` |
| `grantCredits({ userId, amount, kind, expiresAt?, reason, reference?, idempotencyKey })` | Create a lot and its entry |
| `spendCredits({ userId, amount, reason, reference, idempotencyKey })` | Consume lots; **fails 402** if short, never goes negative, never partially spends |
| `reverseSpend({ userId, idempotencyKey })` | Return what a spend consumed, to the same lots |
| `clawBackGrant({ lotId \| reference })` | Remove what remains of a lot (a refunded purchase) and report any shortfall |
| `listEntries({ userId, … })`, `getLot()` | Reads |
| `createClaim()`, `redeemClaim({ token, userId })` | Promo links |

Fire hooks (notification mode, via kempo's `triggerHook`): `credits:granted`, `credits:spent`,
`credits:reversed`, `credits:low` (below a configurable threshold, once per crossing).

### Refunds and shortfall

Refunding a pack purchase claws back what is left of its lot. If some was already spent, the
shortfall is recorded as an **adjustment entry** and the account is flagged with a negative balance
that blocks further spends until cleared — a user must not be able to buy, spend, then refund and
keep the value. Decide nothing silently here: surface the shortfall to an administrator.

## Buying a pack

The flow lives in this extension, because every consumer would otherwise reimplement it:

1. Choose a pack. Server prices it — **never trust an amount from a browser.**
2. If kempo-tax is installed and enabled, `calculateTax` with a digital tax class and the buyer's
   address; `total` is what is charged. If it is not, charge the pack price.
3. `createPayment` with `owner: 'kempo-credits'` and `reference: purchaseId`.
4. On the **`payment:succeeded` hook** — never on the browser's word — grant the lot (idempotent on
   the payment id) and `recordTransaction` with kempo-tax.
5. On the payment's refund hook: claw back, and `reverseTransaction`.

Whether the pack price includes tax or has it added is kempo-tax's `prices_include_tax`; this
extension must work with either and must show the buyer the final amount before they pay.

## Abuse protection

The smallest pack is $0.99 and most buyers will be guests, which is exactly the shape *card testing*
takes: someone runs lists of stolen card numbers through a cheap checkout to see which still work.
It costs the site processor fees and, if it gets bad, the Stripe account itself. This is a real
operational risk of the pricing model, not a corner case.

- **Rate-limit the purchase and payment-creation routes** per user, per IP and globally. Limits are
  settings, with defaults that a real person never hits (a handful of purchase attempts an hour).
- **Count failed payments per user and per IP**, and block further attempts after a threshold for a
  cool-down. A card that was declined three times is not a customer.
- **Require a signed-in user to buy.** Never sell credits to an anonymous session.
- **Never create a payment for an amount the server did not price** (already required above) and
  never accept a pack id the administrator has disabled.
- **Document turning on Stripe Radar** and its rules in the README, as part of going live.
- **Surface it**: an administrator-visible log of blocked attempts, so an attack is noticed before
  the Stripe bill is.
- Tests for each limit, including that a legitimate retry after one decline still works.

Disputes cost a flat fee that wipes out the margin on many small sales. Keep a receipt and the
refund policy visible at the point of purchase, and record what the buyer was shown.

## Dependencies

`kempo-payments` — **hard**, declared in `kempo-config.json` `dependencies`, enforced at install.
`kempo-tax` — optional at runtime: used if present and enabled, ignored if not. Never import it
statically; check it is installed first.

## Admin

Under the **Commerce** nav group. Screens: balances (search by user), a user's ledger, grant promo
credits to a user, packs (CRUD), claim links, purchases, settings. Every screen behind its own
permission. A site must be able to see, for any user, exactly how their balance came to be.

## Permissions and groups

Unprefixed names: `credits:view`, `credits:grant`, `credits:adjust`, `credits:packs`,
`credits:settings`, `credits:purchase` (what an ordinary signed-in user holds, to buy their own).
Groups `kempo-credits:administrator`, `kempo-credits:support`. A user may only ever read and spend
**their own** balance through the API; granting is an administrator action.

## Conventions an agent must follow

Follow `~/dev/kempo/AGENTS.md` and copy the structure of `~/dev/kempo-payments`, the reference
extension. Specifically:

- `server/utils/**` is HTTP-agnostic and returns `[error, data]` tuples; it never throws.
- Routes are `public/api/**/[METHOD].js`; the public scope is `credits`; admin pages under
  `admin/`, components under `admin/components/`.
- Custom elements are prefixed **`k-cred-`**. Icons are `<k-icon>`; none are entities or emoji.
- No custom CSS beyond what kempo-css utility classes cannot do. Edit `src/`, never `dist/`.
- Settings that hold secrets use the `secret` type; declare every setting in `kempo-config.json` and
  write them with their declared type and description (see kempo-payments' `declared.js`).
- Tests: `kempo-test`, PGlite for the unit tier. No mocking. Include the concurrency and idempotency
  tests named above — they are the point of the extension.
- Update `README.md` and `CHANGELOG.md` with every behaviour change.
- **Never** start, stop or restart a dev server. Use what is running.

## Definition of done

- Every SDK function above, with tests, including parallel double-spend and duplicate-webhook cases.
- Pack purchase works end to end against Stripe **test mode**, with and without kempo-tax.
- A refund claws back correctly, including the shortfall case.
- Admin screens for everything listed, permission-gated, loaded and checked in a browser.
- README documents the SDK, the hooks and the paid/promo distinction. CHANGELOG written.
- `npm test` passes in CI, in a clean checkout, with registry copies of the peers.

## Open questions for the owner (do not guess)

- Should paid credits ever expire? Default no; needs a deliberate decision and legal advice.
- Is a promo lot's expiry fixed-date or relative to the grant?
- Minimum purchase or maximum balance limits?
