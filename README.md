# kempo-credits

An in-app currency for [kempo](https://github.com/dustinpoissant/kempo) sites: a ledger that keeps
track of how many credits each account has, moves them between accounts, and gives other extensions
an SDK to create and use them.

That is all it does, on purpose. Credits do not know where they came from. Selling them, handing
them out through links, and rewarding players for an achievement or a watched ad are separate
extensions — or your own code — calling the same `grantCredits`:

| | |
|---|---|
| **kempo-credits** (this) | The ledger, transfers, the SDK, hooks, balances and history. |
| [kempo-credit-packs](https://github.com/dustinpoissant/kempo-credit-packs) | Sell credits through kempo-payments, with tax, abuse protection and refunds. |
| [kempo-credit-claims](https://github.com/dustinpoissant/kempo-credit-claims) | Claim links that give credits to whoever opens them and signs in. |

- **A ledger you can audit.** Credits are held in lots with an append-only list of entries; a balance
  is derived from the lots and never cached, and `auditAccount` proves it from the entries.
- **Safe under concurrency.** Every operation on a user runs under a per-user lock with conditional
  updates underneath, so a double click or two requests at once cannot overspend.
- **Idempotent writes.** Every write takes a key; retrying with the same key applies once.
- **Transfers between accounts** for gifting, or for trading items for credits in a game.
- **Credits never expire.**

## Contents

- [Install](#install)
- [Concepts](#concepts)
- [Using credits from your own code](#using-credits-from-your-own-code)
- [SDK reference](#sdk-reference)
- [Transfers](#transfers)
- [Hooks](#hooks)
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

Install it from the admin's **Extensions** screen. Installing:

- creates the two tables and their indexes, including the unique one that makes retries safe;
- registers the **Credits** dashboard widget, the permissions and groups below, and the admin
  screen under **Commerce**.

A user's own page is at `/credits/`. To let people *buy* credits, install
[kempo-credit-packs](https://github.com/dustinpoissant/kempo-credit-packs).

## Concepts

| | |
|---|---|
| **Lot** | One grant of credits: how many, how many are left, its *kind*, and where it came from. A balance is the sum of a user's lots. |
| **Entry** | One immutable ledger row: a signed amount against a lot, with a reason, a `reference` and who did it. An operation that touches several lots writes one entry per lot, sharing an `operationId`. Entries are never updated or deleted. |
| **Kind** | A free-form lowercase label on a lot — `general` (the default), `purchase`, `promo`, `achievement`, `ad-reward`. It is for reporting and for rules such as *this kind cannot be transferred*; credits of every kind are spent the same way. |
| **Reference** | `{ owner, ref }` on a grant or spend: which extension asked, and its own id for why. It is how an entry is traced back to the thing that caused it. |

### Credits never expire

There is no expiry on a lot, no setting for one, and a grant that asks for one is refused with a 400
so code written expecting one finds out at once.

### Spending order

**Oldest first**, whatever the kind. Each spend's entries record which lots it drew from, so a reversal
puts every credit back where it came from.

### A balance can go below zero — once

Only one thing takes a balance negative: credits being taken back that the user no longer holds — a
refund made somewhere the site cannot stop, such as Stripe's dashboard. The part that could not be
taken is recorded as a **shortfall**; the user then owes credits, **cannot spend** until that is
covered, and whatever they are granted next pays it off first. An administrator can also write it off.
It fires `credits:clawed-back` and notifies everyone with `credits:view`, so it is never silent.

## Using credits from your own code

Everything is server-side, through the SDK. There is **no HTTP route that spends credits**: only the
feature that sells something knows what was bought, so it calls `spendCredits` from its own route.

```js
import { getBalance, spendCredits, reverseSpend, grantCredits } from 'kempo-credits/sdk';

// What does this user have?
const [, balance] = await getBalance({ userId });
// { total: 420, owed: 0, byKind: { general: 300, achievement: 120 } }

// Charge them for something.
const [error, spent] = await spendCredits({
  userId,
  amount: 300,
  reason: 'boost',
  reference: { owner: 'crowd-pulse', ref: event.id },   // who is spending, and their id for what
  idempotencyKey: `boost:${event.id}`,                   // the same on a retry, new for a new spend
});

if(error?.code === 402){
  // Not enough. error.balance and error.needed say by how much — or error.owed, if they owe credits
  // and cannot spend at all until that is covered.
}

// The thing they paid for fell through: give the credits back, to the lots they came from.
await reverseSpend({ userId, idempotencyKey: `boost:${event.id}` });

// Give credits for anything: an achievement, an ad watched, a signup, a monthly allowance.
await grantCredits({
  userId,
  amount: 100,
  kind: 'achievement',
  reason: 'achievement',
  reference: { owner: 'my-game', ref: `achievement:${achievement.id}` },
  idempotencyKey: `achievement:${achievement.id}:${userId}`,
});
```

**Idempotency keys** are the caller's to choose, and choosing them well is the point: the id of the
thing being paid for, the webhook's payment id, the request's own id — something that is the same on
the second attempt and different for the next real one. Sending the same key again returns the first
result with `duplicate: true`. Sending it with a different amount, or for a different kind of
operation, is a 409. A key is filed under the user it belongs to, so two users may use the same one.

Every function returns `[error, data]` with `error = { code, msg }`, and none of them throws. They
are data operations with no permission checks: the routes decide who may call what.

## SDK reference

Imported from `kempo-credits/sdk`.

| Function | Does |
|---|---|
| `getBalance({ userId })` | `{ total, owed, byKind }`. `total` is what can be spent; it is below zero only when `owed` is not zero. |
| `grantCredits({ userId, amount, kind?, reason, reference?, idempotencyKey, actorId?, note? })` | Creates a lot and its entry. `kind` defaults to `general`. Passing an expiry is refused. If the user owes credits, the grant pays that off first (`settled`). |
| `spendCredits({ userId, amount, reason, reference, idempotencyKey, actorId?, note? })` | Takes credits in spending order. **402** if short; never goes negative; never partly spends. |
| `transferCredits({ fromUserId, toUserId, amount, reason, reference?, idempotencyKey, actorId?, note? })` | Moves credits between two accounts as one operation. See [Transfers](#transfers). |
| `reverseSpend({ userId, idempotencyKey, reason?, actorId?, note? })` | Returns what the spend under that key took, to the same lots. |
| `previewClawBack({ lotId \| reference, amount? })` | What a claw back would do, without doing it: `{ userId, claimable, wanted, held, takeable, shortfall }`. What an administrator approving a refund should see first. |
| `clawBackGrant({ lotId \| reference, amount?, reason?, ifShort?, idempotencyKey?, actorId?, note? })` | Takes back a grant, or `amount` of it: from its own lot first, then the user's other credits. If they hold less than that, `ifShort` decides: `'owe'` (the default) records the rest as a **shortfall** they owe, `'zero'` takes what they hold and closes the grant, leaving nobody owing (`unrecovered`). Reports `taken`, `fromOtherCredits`, `shortfall`, `unrecovered`, `owed`. |
| `getGrant({ lotId \| reference })` | A grant and how much of it has been taken back: `{ lot, clawed, removed, claimable }`. |
| `removeCredits({ userId, amount, note?, idempotencyKey, actorId? })` | An administrator taking credits away, in spending order, never more than they have. |
| `forgiveDebt({ userId, amount?, note?, idempotencyKey, actorId? })` | Writes off what a user owes — all of it, or `amount`. |
| `listEntries({ userId, type?, reference?, limit?, offset? })` | The ledger, newest first. |
| `listLots({ userId })`, `getLot({ lotId })`, `getOperation({ operationId })` | Reads. |
| `listAccounts({ search?, owing?, limit?, offset? })`, `creditTotals()` | Balances across users, and site-wide totals. |
| `auditAccount({ userId })` | Proves a balance from the ledger: every lot's `remaining` equals the sum of its entries. `{ ok, problems }`. |
| `EVENTS`, `DEFAULT_KIND`, `MAX_AMOUNT`, `readConfig`, `DEFAULTS`, `OWNER` | Constants and the settings reader. |

## Transfers

```js
const [error, sent] = await transferCredits({
  fromUserId: seller.id,
  toUserId: buyer.id,
  amount: 250,
  reason: 'trade',                                   // 'gift', 'trade', 'payment'…
  reference: { owner: 'my-game', ref: `trade:${trade.id}` },
  idempotencyKey: `trade:${trade.id}`,
});
```

This is what a game needs for trading an item for credits, or a site for gifting. A trade of an item
for credits is the item changing hands and this call under one id — keep both under the same key and a
retry of both is safe.

- **All or nothing**, with both accounts locked, so the credits cannot be sent twice or spent in
  between. Locks are taken in a fixed order, so two people sending to each other at the same moment
  cannot deadlock.
- The recipient gets **one new lot per kind sent**, with the same kind, so a lot's kind survives a gift.
- A sender who **owes** credits cannot send (402), nor can one who does not hold enough *transferable*
  credits (402). Kinds listed in the `non_transferable_kinds` setting are never taken, but can still be
  spent.
- Sending to yourself is a 400. A recipient who owes credits has what they receive pay that off first.
- Fires `credits:transferred`, and `credits:low` for the sender if the balance crossed the threshold.

**Users do not gift each other by default, and this is entirely optional.** Bought credits are
transferable immediately — there is no holding period, and no site cut. Sending is behind
`credits:transfer`, which nobody holds until a site gives it to a group. The API is
`POST /credits/api/my/transfers` and the `<k-cred-send>` component is a ready-made form for it; a site
that wants everyone to gift gives `credits:transfer` to `system:Users` and puts the component on a
page of its own. The `/credits/` page shows the form to holders of the permission and to nobody
else. Code calling `transferCredits` directly (a trading feature, say) needs no permission: it has
already decided.

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
| `credits:granted` | `{ userId, operationId, lot, amount, kind, reason, reference, settled, balance }` | credits were added |
| `credits:spent` | `{ userId, operationId, amount, reason, reference, entries, balance }` | credits were spent |
| `credits:transferred` | `{ fromUserId, toUserId, operationId, amount, reason, reference, settled, fromBalance, toBalance }` | credits moved between accounts |
| `credits:reversed` | `{ userId, operationId, reversedOperationId, amount, reference, balance }` | a spend was undone |
| `credits:clawed-back` | `{ userId, operationId, lot, taken, shortfall, unrecovered, owed, balance }` | a grant was taken back |
| `credits:low` | `{ userId, balance, threshold }` | the balance dropped below `low_balance_threshold` — once per crossing |

Each fires once per operation: a retry under the same key fires nothing. A handler that throws is
logged and stops nothing.

## Components and pages

**`/credits/`** is the signed-in user's page: their balance, a *Send credits* form when they hold
`credits:transfer`, and their history. The components it is built from can go on any page:

```html
<script type="module" src="/credits/components/Balance.js"></script>
<k-cred-balance></k-cred-balance>
<k-cred-balance compact></k-cred-balance>   <!-- just the number, for a header -->
```

| Element | Module | |
|---|---|---|
| `<k-cred-balance>` | `/credits/components/Balance.js` | The signed-in user's balance, and a breakdown by kind when there is more than one. `refresh()` re-reads it. |
| `<k-cred-history>` | `/credits/components/History.js` | The signed-in user's ledger. `refresh()` re-reads it. |
| `<k-cred-send>` | `/credits/components/SendCredits.js` | Send credits to another account by email address. Emits `credits-sent`. |
| `<k-cred-widget>` | `/credits/components/CreditsWidget.js` | The admin dashboard widget: credits held, holders and anything owed. |

A browser client is at `/credits/sdk.js`, returning the same `[error, data]` tuples — `getMyBalance`,
`listMyEntries`, `sendCredits` and the administrative calls. Formatting helpers other extensions'
screens can reuse are at `/credits/utils/format.js`.

## HTTP API

All under `/credits/api`. Routes under `/my/` are about the signed-in user only: they need a session
and nothing else (except sending), and the user always comes from the session, never the request.

| Route | Who |
|---|---|
| `GET /my/balance`, `GET /my/entries` | signed in |
| `POST /my/transfers` `{ toEmail \| toUserId, amount, note?, idempotencyKey }` | `credits:transfer` |
| `GET /accounts`, `GET /accounts/:userId`, `GET /accounts/:userId/entries`, `GET /summary` | `credits:view` |
| `POST /accounts/:userId/grant` | `credits:grant` |
| `POST /accounts/:userId/remove`, `POST /accounts/:userId/forgive`, `POST /lots/:id/claw-back`, `POST /operations/:id/reverse` | `credits:adjust` |
| `GET /settings`, `PUT /settings` | `credits:settings` |

Administrative writes take an `idempotencyKey` in the body; the admin screens make one per form, so a
double click applies once. A `note` is optional; when given, the ledger keeps it.

## Permissions and groups

| Permission | Lets you |
|---|---|
| `credits:view` | See every balance and ledger |
| `credits:grant` | Give credits to a user |
| `credits:adjust` | Take credits away, reverse a spend, claw back a grant, write off what a user owes |
| `credits:settings` | Change the settings below |
| `credits:transfer` | Send your own credits to another account. Held by nobody until a site grants it |

| Group | Has |
|---|---|
| `kempo-credits:support` | admin access, `credits:view`, `credits:grant` — look anybody up and give goodwill credits |
| `kempo-credits:administrator` | admin access and everything above except `credits:transfer` |

## Settings

| Setting | Default | |
|---|---|---|
| `low_balance_threshold` | `0` | Fires `credits:low` below this. 0 is off. |
| `non_transferable_kinds` | *(empty)* | Comma-separated kinds that can be spent but never sent to another account. |

## Admin

**Admin → Commerce → Credits**, one tab per job, each behind its own permission:

- **Balances** — find anybody and open them. A user is a page of their own at
  `/admin/extension/kempo-credits/account/?user=<id>` (so the back button and a pasted link work): their
  balance, every lot they were granted, every change since, and the audit line that proves the balance
  from the ledger. Give, remove, claw back, reverse and write off from there.
- **Give credits** — find a user and give them credits, seeing what they already have.
- **Settings**.

## Not in scope

- **What credits buy.** Features, products, events — that is the consumer's table, tagged with a
  `reference`.
- **Selling credits and claim links.** The two extensions above.
- **Cash value.** Credits are never redeemable for money, by anyone. That is what keeps them a
  closed-loop balance rather than stored value subject to money-transmission rules. There is no
  cash-out path, and one should not be added without the site owner deciding it deliberately.
- **Expiry.** Credits never expire.
- **Subscriptions.** A monthly *grant* is already one call — see the example above.
- **Minimum purchase and maximum balance limits.** Not built — an open question for the owner.

## Data

Two tables. Credits are integers; nothing is a float.

| Table | |
|---|---|
| `kempoCreditLot` | One grant. `remaining` is the sum of its entries — checked by `auditAccount`. |
| `kempoCreditEntry` | The ledger. A **unique index on `(userId, idempotencyKey)`** makes retries apply once; the key is on an operation's first entry only. `counterpartyId` names the other account in a transfer. |

**Concurrency.** Every operation on a user runs in one transaction holding a Postgres advisory lock
for that user, so two operations on the same user queue and the second sees the first's result.
Operations that touch several users take their locks in sorted order. Lot updates are conditional as
well (`remaining + amount >= 0`) and the idempotency key is a unique index, so neither guarantee
rests on the lock alone. Operations on different users never wait.

## Development

```bash
npm install
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
random port, installs this extension through kempo's own install route, and drives Chromium with
Playwright through every screen and the permission contract for every audience. Screenshots land in
`tests/.tmp-site/screens`. It stops its own server when it finishes.

The suites refuse to run against a database whose name does not end in `_test`, because they empty
this extension's tables.
