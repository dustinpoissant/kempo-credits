import { pgTable, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

/*
  Two tables, and nothing else: the ledger and the lots it moves credits between. How credits come to
  exist — bought, earned, claimed, awarded — is the business of whatever calls `grantCredits`, and
  none of it is stored here.

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

  `kind` is a label the granting code chooses (`general` by default). The ledger keeps lots of
  different kinds apart and reports a balance per kind, but does not interpret them; the one thing
  the site does with a kind is the `non_transferable_kinds` setting.

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
  | `transfer_out`| -    | credits sent to another user, drawn from the sender's lots            |
  | `transfer_in` | +    | credits received: the lot being created, on the recipient's side      |
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

  // The other user in a transfer: who the credits went to, or came from.
  counterpartyId: text('counterpartyId'),

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
