import { pgTable, text, boolean, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

/*
  Six tables. Two of them are the ledger, and the other four are the ways credits come into it.

  Credits are integers and money is an integer in the currency's minor unit, as in kempo-payments.
  There is no float anywhere in this file, and nothing that reads from it should produce one.

  The indexes declared here are created by hand in install.js as well. kempo's installer makes
  columns and primary keys from a Drizzle schema and nothing else, and one of these indexes is the
  thing that makes a retried request grant once — see `kempoCreditEntry`. A static test checks the
  two lists agree.
*/

/*
  One grant of credits: how many, how many are left, and where they came from.

  A balance is the sum of `remaining` over a user's lots, and it can be worked out from this table
  alone at any time. Nothing caches it, so nothing can disagree with it.

  **Credits never expire**, paid or promo — the site owner's rule. There is deliberately no expiry
  column, so there is nothing for any code path to set.

  `kind` is `paid` or `promo`, and the two are kept apart because they are different things. Paid
  credits were bought; they are a prepaid balance, and what a refund of the purchase takes back.
  Promo credits were given away; they are not revenue and are never refunded as money.

  `remaining` can go below zero, and that is the one way a balance can: a refund that bypassed the
  site's own check (made in the processor's dashboard, or a chargeback) taking back more than the
  user still held. The part that could not be taken is recorded against the lot as a shortfall, so
  the balance shows exactly what is owed, and credits granted afterwards pay it off first. See
  server/utils/ledger/clawback.js.
*/
export const kempoCreditLot = pgTable('kempoCreditLot', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),

  kind: text('kind').notNull(),
  amount: integer('amount').notNull(),
  remaining: integer('remaining').notNull(),

  /*
    Why it was granted, in the granting code's words (`purchase`, `claim`, `award`, `monthly`), and
    who it was granted for: `referenceOwner` is the extension or feature that asked and
    `referenceId` its own id for the reason — a purchase, a claim link, a competition entry.
  */
  reason: text('reason').notNull(),
  referenceOwner: text('referenceOwner'),
  referenceId: text('referenceId'),

  operationId: text('operationId').notNull(),
  actorId: text('actorId'),
  note: text('note'),

  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => ({
  userIndex: index('kempoCreditLot_user_idx').on(table.userId),
  referenceIndex: index('kempoCreditLot_reference_idx').on(table.referenceOwner, table.referenceId),
}));

/*
  The ledger. Every change to any lot is one row here, and rows are never updated or deleted.

  An *operation* — a grant, a spend, a reversal — writes one entry per lot it touches, all sharing
  an `operationId`. A spend of 120 drawn from two lots is two entries of -100 and -20, which is what
  lets a reversal put each credit back where it came from.

  **The unique index on `(userId, idempotencyKey)` is a correctness guarantee, not an
  optimisation.** It is what makes a request that is retried, or a webhook delivered twice, apply
  once. The key is stored on an operation's first entry only and is null on the others, which
  Postgres treats as distinct, so a multi-lot spend is still one operation under one key.

  `type` is what happened to the lot:

  | type          | sign | what it is                                                            |
  |---------------|------|-----------------------------------------------------------------------|
  | `grant`       | +    | the lot being created                                                 |
  | `spend`       | -    | credits used on something                                             |
  | `reversal`    | +    | a spend undone, returned to the lot it came from                      |
  | `clawback`    | -    | credits taken back by a refund — from the purchase's own lot first,   |
  |               |      | then from the user's other credits                                    |
  | `shortfall`   | -    | what a refund could not take back: the lot goes below zero            |
  | `settlement`  | ±    | credits moved from a positive lot to pay off a negative one           |
  | `removal`     | -    | an administrator taking credits away                                  |
  | `forgiveness` | +    | an administrator writing off what a user owes                         |

  `reversesOperationId` points a reversal at the spend it undoes, and a claw back at the grant it
  takes back — which is how a refund knows how much of a purchase is already back, wherever it came
  from.

  For every lot, `remaining` equals the sum of its entries. That is checked after every operation in
  the tests and by `auditAccount`.
*/
export const kempoCreditEntry = pgTable('kempoCreditEntry', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  lotId: text('lotId').notNull(),
  operationId: text('operationId').notNull(),

  type: text('type').notNull(),
  amount: integer('amount').notNull(),

  reason: text('reason'),
  referenceOwner: text('referenceOwner'),
  referenceId: text('referenceId'),

  idempotencyKey: text('idempotencyKey'),
  reversesOperationId: text('reversesOperationId'),

  // The person who did it, where a person did. Null for the system acting on its own — a webhook.
  actorId: text('actorId'),
  note: text('note'),

  createdAt: timestamp('createdAt').notNull(),
}, table => ({
  idempotencyIndex: uniqueIndex('kempoCreditEntry_idempotency_idx').on(table.userId, table.idempotencyKey),
  userIndex: index('kempoCreditEntry_user_idx').on(table.userId, table.createdAt),
  lotIndex: index('kempoCreditEntry_lot_idx').on(table.lotId),
  operationIndex: index('kempoCreditEntry_operation_idx').on(table.operationId),
  referenceIndex: index('kempoCreditEntry_reference_idx').on(table.referenceOwner, table.referenceId),
}));

/*
  Something a user can buy: this many credits for this much money, as an administrator set it.

  The price is the only one a purchase ever charges. A browser names a pack, never an amount.
*/
export const kempoCreditPack = pgTable('kempoCreditPack', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),

  credits: integer('credits').notNull(),
  price: integer('price').notNull(),
  currency: text('currency').notNull(),

  enabled: boolean('enabled').notNull().default(true),
  sort: integer('sort').notNull().default(0),

  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
});

/*
  One attempt to buy a pack, from the moment it is priced to the moment it is paid, refunded or
  given up on. It ties together the pack as it was then, the payment, the tax quote and, once paid,
  the lot that was granted.

  It is also the abuse log. An attempt refused by a rate limit or a decline cool-down is written
  here with `status: 'blocked'` and the reason, and never reaches the payment processor — so an
  administrator sees an attack in this table before it shows up on the processor's bill. The same
  rows are what the limits count, which is why `ip` is kept.

  `shown` is what the buyer was shown before paying: the pack, the price, the tax, the total and the
  refund policy, exactly as rendered. A dispute is answered with it.
*/
export const kempoCreditPurchase = pgTable('kempoCreditPurchase', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  status: text('status').notNull(),

  packId: text('packId'),
  packName: text('packName'),
  credits: integer('credits').notNull().default(0),

  currency: text('currency'),
  subtotal: integer('subtotal').notNull().default(0),
  tax: integer('tax').notNull().default(0),
  total: integer('total').notNull().default(0),
  includesTax: boolean('includesTax').notNull().default(false),

  paymentId: text('paymentId'),
  lotId: text('lotId'),

  taxCalculationId: text('taxCalculationId'),
  taxTransactionId: text('taxTransactionId'),
  taxError: text('taxError'),

  failures: integer('failures').notNull().default(0),
  lastFailedAt: timestamp('lastFailedAt'),
  lastError: text('lastError'),
  blockedReason: text('blockedReason'),

  refundedAmount: integer('refundedAmount').notNull().default(0),
  creditsClawedBack: integer('creditsClawedBack').notNull().default(0),
  shortfall: integer('shortfall').notNull().default(0),
  disputed: boolean('disputed').notNull().default(false),

  ip: text('ip'),
  userAgent: text('userAgent'),
  shown: jsonb('shown'),

  checkedAt: timestamp('checkedAt'),
  paidAt: timestamp('paidAt'),
  refundedAt: timestamp('refundedAt'),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => ({
  userIndex: index('kempoCreditPurchase_user_idx').on(table.userId, table.createdAt),
  ipIndex: index('kempoCreditPurchase_ip_idx').on(table.ip, table.createdAt),
  createdIndex: index('kempoCreditPurchase_created_idx').on(table.createdAt),
  statusIndex: index('kempoCreditPurchase_status_idx').on(table.status),
  paymentIndex: index('kempoCreditPurchase_payment_idx').on(table.paymentId),
}));

/*
  A link that grants promo credits to whoever redeems it.

  Only a hash of the token is kept. The link is shown once, when it is made — a database backup
  that leaks must not be a way to mint credits. `tokenHint` is the last few characters, so an
  administrator can tell two links apart.

  `expiresAt` is when the *link* stops working. The credits it has already granted never expire.
*/
export const kempoCreditClaim = pgTable('kempoCreditClaim', {
  id: text('id').primaryKey(),
  tokenHash: text('tokenHash').notNull(),
  tokenHint: text('tokenHint'),
  name: text('name'),

  amount: integer('amount').notNull(),

  expiresAt: timestamp('expiresAt'),
  maxRedemptions: integer('maxRedemptions'),
  redemptions: integer('redemptions').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),

  createdBy: text('createdBy'),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => ({
  tokenIndex: uniqueIndex('kempoCreditClaim_token_idx').on(table.tokenHash),
}));

/*
  Who redeemed which link. The primary key is `claimId:userId` rather than a generated id, so "one
  redemption per person per link" rests on the one constraint kempo's installer is guaranteed to
  create, not on an index that might not exist.
*/
export const kempoCreditClaimRedemption = pgTable('kempoCreditClaimRedemption', {
  id: text('id').primaryKey(),
  claimId: text('claimId').notNull(),
  userId: text('userId').notNull(),
  lotId: text('lotId').notNull(),
  createdAt: timestamp('createdAt').notNull(),
}, table => ({
  claimIndex: index('kempoCreditClaimRedemption_claim_idx').on(table.claimId),
}));
