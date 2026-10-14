# kempo-credits — PLAN

> Status: **built** (2026-10-14). README.md documents what exists; CHANGELOG.md lists what changed.
> This file is the brief, kept current with the decisions the owner has made.

> **Upstream changes are allowed.** Every dependency with `kempo` in its name (kempo, kempo-ui,
> kempo-css, kempo-server, kempo-payments, kempo-media, and the rest) is owned by the same person, and
> the goal of this project is to keep improving all of them. If the work here needs a change in one of
> them — a UI component, a payment call, a CMS hook — **make it, in that repository, without asking
> and without deferring it to a later step.** Do it the normal way there: tests, README and CHANGELOG,
> a backwards-compatible change where other packages depend on it, and the dependency order when
> publishing. Never commit a `file:` specifier.

## What it is

An in-app currency for kempo sites. **kempo-credits handles only credits**: it keeps track of how many
credits each account has, allows credits to be transferred from one account to another, and offers an
SDK that lets other extensions create and use them. Every change is an entry in an append-only ledger.

It does **not** deal with how credits are obtained. A player can earn them for watching an ad or an
in-game achievement as readily as buy them, so credits are not linked to purchases. It knows nothing
about what credits are spent *on*.

## The three packages

| Package | Job | Depends on |
|---|---|---|
| **kempo-credits** | The ledger, transfers, SDK, hooks, balances, history, admin balances/grant/settings. | kempo only. |
| **kempo-credit-packs** | Packs of credits sold through kempo-payments; tax via kempo-tax when present; abuse limits; the refund rule. A pack is a product whose purchase grants credits. | kempo-credits, kempo-payments (kempo-tax optional). |
| **kempo-credit-claims** | Claim links: a token that grants credits to whoever redeems it, once per person, up to a limit. | kempo-credits. |

Nothing in kempo-credits imports, names or reads a pack, a purchase, a payment or a claim; a static
test keeps it that way. The other two reach the ledger only through `kempo-credits/sdk`.

## Why it exists

The first consumer is [crowd-pulse.app](../crowd-pulse.app/PLAN.md), where almost every feature costs
$1–5 and card processing costs about 3% + $0.30 per charge — so selling features one at a time would
lose a third of every sale to fees. Credits let a user pay once for a bulk pack and spend it in
small pieces.

It is a separate extension, not part of Crowd Pulse, because it passes the test every kempo
extension has to: *would anything other than this app use it on its own?* Any site with points,
tokens, usage billing, a loyalty scheme, an in-game currency or a prepaid wallet needs exactly this
ledger.

## Not in scope

- **What credits buy.** Features, products, events — that is the consumer's table, tagged with a
  `reference`.
- **Cash value.** Credits are never redeemable for money, by anyone. That is what keeps them a
  closed-loop balance rather than stored value subject to money-transmission rules. Do not build a
  cash-out path, and do not let one be added without the owner deciding it deliberately.
- **Subscriptions.** Recurring billing needs Stripe Billing in kempo-payments, which does not exist.
  A monthly grant is one SDK call.
- **Expiry.** Credits never expire.

## Concepts

- **Lot** — one grant of credits: amount, what is left, a free-form *kind* label, and a reference.
- **Entry** — one immutable ledger row against a lot: a signed amount, a type (`grant`, `spend`,
  `reversal`, `clawback`, `shortfall`, `settlement`, `removal`, `forgiveness`, `transfer_out`,
  `transfer_in`), a reason, a reference, an actor and, for transfers, the counterparty.
- **Balance** — derived: the sum of a user's lots, never cached. Below zero only when the user *owes*
  credits after a refund the site could not stop.
- **Spending order** — oldest first, whatever the kind.
- **Idempotency** — every write takes a key, unique per user; the same key applies once.
- **Concurrency** — one Postgres advisory lock per user per operation (sorted, for multi-user
  operations), with conditional lot updates underneath.

## Permissions and groups

`credits:view`, `credits:grant`, `credits:adjust`, `credits:settings`, `credits:transfer` (held by
nobody until a site grants it). Groups `kempo-credits:support` and `kempo-credits:administrator`. A
user may only ever read their own balance through the API; granting is an administrator action, and
**there is no HTTP route that spends credits**.

## Conventions an agent must follow

Follow `~/dev/kempo/AGENTS.md` and copy the structure of `~/dev/kempo-payments`, the reference
extension. Specifically:

- `server/utils/**` is HTTP-agnostic and returns `[error, data]` tuples; it never throws.
- Routes are `public/api/**/[METHOD].js`; the public scope is `credits`; admin pages under
  `admin/`, components under `admin/components/`.
- Custom elements are prefixed **`k-cred-`** (`k-cpack-` in packs, `k-cclaim-` in claims). Icons are
  `<k-icon>`; none are entities or emoji.
- No custom CSS beyond what kempo-css utility classes cannot do. Edit `src/`, never `dist/`.
- Declare every setting in `kempo-config.json` and write them with their declared type and
  description (see `server/utils/config/declared.js`).
- Tests: `kempo-test`, PGlite for the unit tier, a real Postgres for the integration tier. No
  mocking. The concurrency and idempotency tests are the point of the extension; mutation-check them.
- Update `README.md` and `CHANGELOG.md` with every behaviour change.
- **Never** start, stop or restart a dev server. Use what is running.

## Definition of done

- Every SDK function, with tests, including parallel double-spend, duplicate-grant and
  crossing-transfer (no deadlock) cases.
- Admin screens for everything listed, permission-gated, loaded and checked in a browser.
- README documents the SDK, the hooks and transfers. CHANGELOG written.
- `npm test` passes in CI, in a clean checkout, with registry copies of the peers.

## Decisions (owner, 2026-10-14)

- **No credit ever expires**, bought or promo. No expiry column, setting or sweep; a grant that asks
  for one is refused.
- **Spent credits are never refunded as money.** A purchase is refundable only as far as the buyer
  still holds its credits. If credits were spent on something never received, an administrator gives
  them back first (reverse the spend, or grant credits) and the buyer can then be refunded. (This
  rule lives in kempo-credit-packs.)
- **kempo-credits handles only credits.** Selling and claim links are their own extensions; credits
  are not explicitly linked to purchases. A pack is a product that grants credits.
- **Transfers between accounts exist**, for in-game currency trading and gifting. Users cannot gift
  by default (`credits:transfer`); code can always call `transferCredits`.

## Open questions for the owner (do not guess)

- **Transfer risk.** Should credits bought with a card be transferable at once, or held for a period?
  A holding period would blunt gift-card-style laundering of stolen cards. Today a site can mark kinds
  non-transferable (`non_transferable_kinds`), which is the lever; there is no time-based rule.
- **Gifting from the UI.** The *Send credits* form exists but only for holders of `credits:transfer`.
  Should it be on for everyone on a game site?
- **Minimum purchase or maximum balance limits?** Not built.
