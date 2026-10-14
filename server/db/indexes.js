import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  The indexes server/db/schema.js declares, created by hand — kempo's installer makes columns and
  primary keys from a Drizzle schema and nothing else. install.js and update.js both run this, and a
  static test checks the list against the schema.

  The unique index on `(userId, idempotencyKey)` is a correctness guarantee rather than speed: it is
  what makes a retried request or a redelivered webhook grant once. Failing to make it throws, which
  fails the install. Failing to make any of the others is a warning.
*/
export const INDEXES = [
  { name: 'kempoCreditEntry_idempotency_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCreditEntry_idempotency_idx" ON "kempoCreditEntry" ("userId", "idempotencyKey")` },
  { name: 'kempoCreditEntry_user_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditEntry_user_idx" ON "kempoCreditEntry" ("userId", "createdAt")` },
  { name: 'kempoCreditEntry_lot_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditEntry_lot_idx" ON "kempoCreditEntry" ("lotId")` },
  { name: 'kempoCreditEntry_operation_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditEntry_operation_idx" ON "kempoCreditEntry" ("operationId")` },
  { name: 'kempoCreditEntry_reference_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditEntry_reference_idx" ON "kempoCreditEntry" ("referenceOwner", "referenceId")` },
  { name: 'kempoCreditLot_user_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditLot_user_idx" ON "kempoCreditLot" ("userId")` },
  { name: 'kempoCreditLot_reference_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCreditLot_reference_idx" ON "kempoCreditLot" ("referenceOwner", "referenceId")` },
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
