# Changelog

All notable changes to `kempo-credits` are documented in this file.

## [Unreleased]

The first working release: everything PLAN.md describes.

### Added

- **A credits ledger.** Lots (one grant each, `paid` or `promo`, with an optional expiry) and an
  append-only entry table. A balance is the sum of a user's live lots and is never cached, so nothing
  can disagree with it; `auditAccount` proves it from the entries.
- **The SDK**: `getBalance`, `grantCredits`, `spendCredits` (all or nothing, 402 when short),
  `reverseSpend` (back to the same lots), `clawBackGrant`, `removeCredits`, `forgiveDebt`, the reads,
  and `expireLots`. Every write takes an idempotency key, guarded by a unique index on
  `(userId, idempotencyKey)` that install.js creates by hand.
- **Spending order**: soonest-expiring first, promo before paid when they expire together, oldest
  after that.
- **Concurrency.** A per-user Postgres advisory lock around every operation, with conditional lot
  updates underneath. Tested with parallel spends, parallel duplicate grants and a refund racing
  spends, on PGlite and on a real Postgres, and mutation-checked: without the lock and the guard the
  double-spend test catches a real overspend.
- **Packs** and the **purchase flow** through kempo-payments: server-priced, taxed by kempo-tax when
  it is installed and enabled (loaded dynamically, never required), granted on `payment:succeeded`,
  recorded and reversed in kempo-tax's ledger, with what the buyer was shown kept on each purchase.
- **Refunds** take back the refunded share of the pack. Credits already spent become a shortfall: a
  negative balance that blocks spending until it is covered or written off, paid off first by any
  later grant, and reported to every administrator.
- **Disputes** flag the purchase and notify; nothing is taken back automatically.
- **Card-testing protection**: rate limits per account, per address and site-wide; a decline
  cool-down that also cancels the payment at the processor; signed-in buyers only; a blocked-attempt
  log and notifications.
- **Claim links** for promo credits, stored as a hash and shown once, one redemption per person,
  limits that hold under concurrent redemption, and expiry by date or days after claiming.
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

### Decided while building, open to the owner

- **Paid credits never expire** by default (PLAN.md's open question); expiry is a setting, off, with a
  warning.
- **Promo expiry is either**: a fixed date or a number of days after the grant, per grant and per
  claim link, rather than one rule for the site.
- **A shortfall is settled from the user's other credits at once**, and any later grant pays the rest
  off first, rather than leaving the account frozen until an administrator acts. An administrator can
  still write it off.
- **Staff groups carry `system:admin:access`**, as kempo-products' and kempo-inventory's do, so their
  members can open the admin.
