# Changelog

All notable changes to `kempo-credits` are documented in this file.

## [Unreleased]

The first working release: everything PLAN.md describes.

### Added

- **A credits ledger.** Lots (one grant each, `paid` or `promo`) and an append-only entry table.
  A balance is the sum of a user's lots and is never cached, so nothing can disagree with it;
  `auditAccount` proves it from the entries.
- **The SDK**: `getBalance`, `grantCredits`, `spendCredits` (all or nothing, 402 when short),
  `reverseSpend` (back to the same lots), `clawBackGrant`, `removeCredits`, `forgiveDebt` and the
  reads. Every write takes an idempotency key, guarded by a unique index on
  `(userId, idempotencyKey)` that install.js creates by hand.
- **No credit ever expires**, paid or promo — no expiry column, setting or sweep, and a grant or claim
  link that asks for one is refused. A static test keeps it that way.
- **Spending order**: promo before paid, oldest first.
- **Concurrency.** A per-user Postgres advisory lock around every operation, with conditional lot
  updates underneath. Tested with parallel spends, parallel duplicate grants and a refund racing
  spends, on PGlite and on a real Postgres, and mutation-checked: without the lock and the guard the
  double-spend test catches a real overspend.
- **Packs** and the **purchase flow** through kempo-payments: server-priced, taxed by kempo-tax when
  it is installed and enabled (loaded dynamically, never required), granted on `payment:succeeded`,
  recorded and reversed in kempo-tax's ledger, with what the buyer was shown kept on each purchase.
- **Refunds only for credits the buyer still holds.** Spent credits are never refunded as money.
  `refundableFor` / `refundPurchase` and a **Refund** button on each purchase refund exactly what is
  still held; a glitch is put right by reversing the spend (or giving credits) first. The same rule
  guards kempo-payments' own Refund button through its `payment:refunding` hook (kempo-payments
  0.1.10+). A refund the site cannot stop — Stripe's dashboard, a chargeback — still cannot let the
  buyer keep what was spent: what it could not take back is a shortfall that blocks spending until
  covered, paid off first by any later grant, and reported to every administrator.
- **Disputes** flag the purchase and notify; nothing is taken back automatically.
- **Card-testing protection**: rate limits per account, per address and site-wide; a decline
  cool-down that also cancels the payment at the processor; signed-in buyers only; a blocked-attempt
  log and notifications.
- **Claim links** for promo credits, stored as a hash and shown once, one redemption per person,
  limits that hold under concurrent redemption, and a link that can stop working after a number of
  days (the credits it gave never do).
- **Hooks**: `credits:granted`, `credits:spent`, `credits:reversed`, `credits:clawed-back`,
  `credits:low` (once per crossing of `low_balance_threshold`).
- **Admin** under Commerce: Balances (with each user's lots, ledger and audit), Give credits,
  Purchases (with the blocked-attempt log), Packs, Claim links and Settings, each behind its own
  permission; a dashboard widget.
- **Buyer pages** `/credits/` and `/credits/claim`, and the components `<k-cred-balance>`,
  `<k-cred-buy>`, `<k-cred-history>` and `<k-cred-claim>`.
- **Tests**: a unit tier on PGlite, an integration tier on Postgres, and a browser suite that builds a
  throwaway kempo site, installs the extension through kempo's own route and drives every screen in
  Chromium with Playwright.

### Decided

By the owner (2026-10-14):

- **No credit ever expires**, bought or promo.
- **Spent credits are never refunded.** A purchase is refundable only for credits still held; a spend
  on something never received is put right by giving the credits back first.

While building, and accepted:

- A shortfall from a refund the site could not stop is settled from the user's other credits, and any
  later grant pays off the rest first; an administrator can write it off.
- Disputes only flag the purchase and notify; nothing is taken back automatically.
- Staff groups carry `system:admin:access`, as kempo-products' and kempo-inventory's do.
- No minimum purchase or maximum balance.
