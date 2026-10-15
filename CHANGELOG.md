# Changelog

All notable changes to `kempo-credits` are documented in this file.

## [Unreleased]

The first working release. It is the ledger, and only the ledger: how credits are obtained is up to
whatever calls `grantCredits` — kempo-credit-packs sells them, kempo-credit-claims hands them out
through links, and a game can reward them.

### Added

- **A credits ledger.** Lots (one grant each, with a free-form `kind` label) and an append-only entry
  table. A balance is the sum of a user's lots and is never cached, so nothing can disagree with it;
  `auditAccount` proves it from the entries.
- **The SDK**: `getBalance`, `grantCredits`, `spendCredits` (all or nothing, 402 when short),
  `transferCredits`, `reverseSpend` (back to the same lots), `clawBackGrant`, `getGrant`,
  `removeCredits`, `forgiveDebt` and the reads. Every write takes an idempotency key, guarded by a
  unique index on `(userId, idempotencyKey)` that install.js creates by hand.
- **Transfers between accounts** — `transferCredits` and `POST /credits/api/my/transfers`, with a
  *Send credits* form on `/credits/`. All or nothing, both accounts locked in a fixed order so two
  people sending to each other cannot deadlock, one lot per kind on the recipient's side, a
  `non_transferable_kinds` setting, and `credits:transferred`. Users cannot send by default: nobody
  holds `credits:transfer` until a site gives it to a group.
- **No credit ever expires** — no expiry column, setting or sweep, and a grant that asks for one is
  refused. A static test keeps it that way.
- **Spending order**: oldest first.
- **Concurrency.** A per-user Postgres advisory lock around every operation, with conditional lot
  updates underneath. Tested with parallel spends, parallel duplicate grants, racing transfers and
  crossing transfers, on PGlite and on a real Postgres, and mutation-checked: without the lock and the
  guard the double-spend test catches a real overspend, and unsorted locks deadlock.
- **Shortfalls.** Credits taken back that a user no longer holds leave a recorded debt: spending is
  blocked until it is covered, any later grant pays it off first, an administrator can write it off,
  and every holder of `credits:view` is notified.
- **Hooks**: `credits:granted`, `credits:spent`, `credits:transferred`, `credits:reversed`,
  `credits:clawed-back`, `credits:low` (once per crossing of `low_balance_threshold`).
- **Admin** under Commerce: Balances, Give credits and Settings, each behind its own permission; a
  dashboard widget. A user's lots, ledger and audit are a page of their own
  (`/admin/extension/kempo-credits/account/?user=`), reached by a real link, so the address changes and
  the back button returns to the list.
- **The user's page** `/credits/` and the components `<k-cred-balance>`, `<k-cred-history>` and
  `<k-cred-send>`.
- **Tests**: a unit tier on PGlite, an integration tier on Postgres, and a browser suite that builds a
  throwaway kempo site, installs the extension through kempo's own route and drives every screen in
  Chromium with Playwright.

### Decided

By the owner (2026-10-14):

- **No credit ever expires**, bought or promo.
- **kempo-credits handles only credits.** Selling credits and claim links are the separate
  kempo-credit-packs and kempo-credit-claims. Credits are not explicitly linked to purchases.
- **Spent credits are never refunded as money**; a glitch is put right by giving the credits back
  first. (Enforced by kempo-credit-packs.)
- **Transfers** between accounts exist, for trading and gifting.
- **Bought credits are transferable immediately** (no holding period), gifting is behind
  `credits:transfer` with an API and no built-in public page, and there is **no site cut** on transfers.
