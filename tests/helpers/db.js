import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  Shared by the database-backed suites. See scripts/run-tests.js for the tiers.
*/

export const unitTier = process.env.KEMPO_DB === 'pglite';
export const integrationTier = process.env.KEMPO_TEST_TIER === 'integration';

const name = (() => {
  try {
    return new URL(process.env.DATABASE_URL).pathname.slice(1);
  } catch {
    return '';
  }
})();

/*
  The suites empty this extension's tables. That is only acceptable on a throwaway database, so a
  database whose name does not end in `_test` is refused outright rather than trusted because it
  happens to be reachable — pointing a run at a site's real database must not be able to wipe its
  ledger. The unit tier is an in-memory database and always a throwaway.
*/
export const isTestDatabase = unitTier || name.endsWith('_test');

const reachable = isTestDatabase && await db.execute(sql`select 1`).then(() => true).catch(() => false);

if(!reachable){
  throw new Error(isTestDatabase
    ? 'No database: run `npm test` (in-memory), or set DATABASE_URL to a throwaway Postgres for `npm run test:integration`.'
    : `The database ${name ? `"${name}"` : 'in DATABASE_URL'} is not named *_test, and these suites empty its tables. Point DATABASE_URL at a throwaway database.`);
}

/*
  The suite for a file that belongs to the integration tier, reported as such in the unit tier. It is
  explicit rather than a silent skip, and `npm run test:integration` is where it runs.
*/
export const integrationOnly = name => ({
  [`${name} (integration tier)`]: async ({ pass }) => pass('runs in `npm run test:integration`: it needs a real Postgres or a second server process'),
});

/*
  Seeds kempo's system groups, permissions and settings in-process.
*/
export const seedDatabase = async () => (await import('kempo/server/utils/setup/seedDatabase.js')).default({ log: () => {} });

export { db };
