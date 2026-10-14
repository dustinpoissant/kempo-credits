import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  The indexes server/db/schema.js declares, created by hand — kempo's installer makes columns and
  primary keys from a Drizzle schema and nothing else. install.js and update.js both run this, and a
  static test checks the list against the schema.

  Two are correctness guarantees rather than speed: the unique index on `(userId, idempotencyKey)` is
  what makes a retried request or a redelivered webhook grant once, and the one on a claim's token
  hash keeps two links from sharing a token. Failing to make either throws, which fails the install.
  Failing to make any of the others is a warning.
*/
export const INDEXES = [
  { name: 'kempoCreditEntry_idempotency_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCreditEntry_idempotency_idx" ON "kempoCreditEntry" ("userId", "idempotencyKey")` },
  { name: 'kempoCreditClaim_token_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCreditClaim_token_idx" ON "kempoCreditClaim" ("tokenHash")` },
  { name: 'kempoCreditEntry_user_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditEntry_user_idx" ON "kempoCreditEntry" ("userId", "createdAt")` },
  { name: 'kempoCreditEntry_lot_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditEntry_lot_idx" ON "kempoCreditEntry" ("lotId")` },
  { name: 'kempoCreditEntry_operation_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditEntry_operation_idx" ON "kempoCreditEntry" ("operationId")` },
  { name: 'kempoCreditEntry_reference_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditEntry_reference_idx" ON "kempoCreditEntry" ("referenceOwner", "referenceId")` },
  { name: 'kempoCreditLot_user_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditLot_user_idx" ON "kempoCreditLot" ("userId")` },
  { name: 'kempoCreditLot_reference_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditLot_reference_idx" ON "kempoCreditLot" ("referenceOwner", "referenceId")` },
  { name: 'kempoCreditPurchase_user_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditPurchase_user_idx" ON "kempoCreditPurchase" ("userId", "createdAt")` },
  { name: 'kempoCreditPurchase_ip_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditPurchase_ip_idx" ON "kempoCreditPurchase" ("ip", "createdAt")` },
  { name: 'kempoCreditPurchase_created_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditPurchase_created_idx" ON "kempoCreditPurchase" ("createdAt")` },
  { name: 'kempoCreditPurchase_status_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditPurchase_status_idx" ON "kempoCreditPurchase" ("status")` },
  { name: 'kempoCreditPurchase_payment_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditPurchase_payment_idx" ON "kempoCreditPurchase" ("paymentId")` },
  { name: 'kempoCreditClaimRedemption_claim_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditClaimRedemption_claim_idx" ON "kempoCreditClaimRedemption" ("claimId")` },
];

export const createIndexes = async () => {
  for(const index of INDEXES){
    try {
      await db.execute(index.sql);
    } catch(error) {
      if(index.required) throw new Error(`[kempo-credits] Could not create ${index.name}, which the ledger cannot work safely without: ${error.message}`);
      console.warn(`[kempo-credits] Could not create the index ${index.name}: ${error.message}`);
    }
  }
};
