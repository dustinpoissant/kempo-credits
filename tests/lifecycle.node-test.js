import { sql } from 'drizzle-orm';
import { setSetting } from 'kempo/server/sdk.js';
import { setting } from 'kempo/server/db/schema.js';
import { like } from 'drizzle-orm';
import install from '../install.js';
import update from '../update.js';
import uninstall from '../uninstall.js';
import { INDEXES } from '../server/db/indexes.js';
import { kempoCreditEntry } from '../server/db/schema.js';
import grantCredits from '../server/utils/ledger/grant.js';
import { listEntries } from '../server/utils/ledger/read.js';
import { db, seedDatabase } from './helpers/db.js';
import { freshUser, key, purge } from './helpers/ledger.js';

/*
  What kempo runs when this extension is installed, updated and removed.

  The test database already has every index — drizzle-kit made them from the schema — which is
  exactly why a mistake in install.js would never show. So they are dropped first, and install.js has
  to put them back. The unique one is then proved to work by trying to break it.
*/

const existingIndexes = async () => {
  const rows = await db.execute(sql`select indexname from pg_indexes where tablename like 'kempoCredit%'`);
  return new Set(rows.map(row => row.indexname));
};

const dropIndexes = async () => {
  for(const { name } of INDEXES) await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`));
};

const quietly = async run => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await quietly(install);
  await purge();
};

export default {
  'install creates every index, and the unique one holds': async ({ pass, fail }) => {
    await dropIndexes();
    const before = await existingIndexes();
    if(INDEXES.some(({ name }) => before.has(name))) return fail('the indexes were not dropped, so this proves nothing');

    await quietly(install);

    const after = await existingIndexes();
    const missing = INDEXES.filter(({ name }) => !after.has(name)).map(({ name }) => name);
    if(missing.length) return fail(`install did not create ${missing.join(', ')}`);

    const user = freshUser();
    const [, granted] = await grantCredits({ userId: user, amount: 10, reason: 'test', idempotencyKey: 'same' });
    try {
      await db.insert(kempoCreditEntry).values({
        id: 'ent_duplicate', userId: user, lotId: granted.lot.id, operationId: 'op_duplicate', type: 'grant', amount: 10,
        idempotencyKey: 'same', createdAt: new Date(),
      });
      return fail('a second entry under the same idempotency key was accepted');
    } catch {
      pass('');
    }
  },

  /*
    Settings that used to belong here — selling credits, claim links, expiry — were removed. kempo's
    update never deletes a setting, so update.js does, or they would sit on /admin/settings
    promising something that no longer happens. The ones this extension still has are left alone.
  */
  'update retires the settings that moved out, and keeps the ones that stayed': async ({ pass, fail }) => {
    await setSetting('kempo-credits', 'paid_credits_expire', true, 'boolean', false, 'old');
    await setSetting('kempo-credits', 'refund_policy', 'old policy', 'string', false, 'old');
    await setSetting('kempo-credits', 'purchase_limit_global', 5, 'number', false, 'old');
    await setSetting('kempo-credits', 'low_balance_threshold', 25, 'number', false, 'kept');

    await quietly(update);

    const rows = await db.select().from(setting).where(like(setting.name, 'kempo-credits:%'));
    const names = rows.map(row => row.name.replace('kempo-credits:', ''));
    for(const retired of ['paid_credits_expire', 'refund_policy', 'purchase_limit_global']){
      if(names.includes(retired)) return fail(`${retired} is still there after an update`);
    }
    if(!names.includes('low_balance_threshold')) return fail('a setting this extension still has was deleted');
    pass('');
  },

  'nobody holds credits:transfer after installing': async ({ pass, fail }) => {
    await quietly(install);
    const rows = await db.execute(sql`select 1 from "groupPermission" where "permissionName" = 'credits:transfer'`);
    if(rows.length) return fail('installing gave credits:transfer to a group');
    pass('');
  },

  'update adds a column an older ledger lacks, and the ledger reads again': async ({ pass, fail }) => {
    await db.execute(sql.raw('ALTER TABLE "kempoCreditEntry" DROP COLUMN IF EXISTS "counterpartyId"'));
    await quietly(update);

    const user = freshUser();
    await grantCredits({ userId: user, amount: 10, reason: 'test', idempotencyKey: key() });
    const [error, listed] = await listEntries({ userId: user });
    if(error) return fail(`the ledger could not be read after the update: ${error.msg}`);
    if(listed.entries.length !== 1) return fail(`${listed.entries.length} entries`);
    pass('');
  },

  'update is safe to run any number of times': async ({ pass, fail }) => {
    await quietly(update);
    await quietly(update);
    const indexes = await existingIndexes();
    if(INDEXES.some(({ name }) => !indexes.has(name))) return fail('an index went missing');
    pass('');
  },

  'uninstall deletes nothing, and says how many credits are at stake': async ({ pass, fail }) => {
    await purge();
    const user = freshUser();
    await grantCredits({ userId: user, amount: 700, reason: 'purchase', idempotencyKey: key() });

    const lines = [];
    const { log, warn } = console;
    console.log = message => lines.push(String(message));
    console.warn = message => lines.push(String(message));
    try {
      await uninstall();
    } finally {
      console.log = log;
      console.warn = warn;
    }

    if(!lines.some(line => line.includes('700'))) return fail(`it did not mention the 700 credits: ${lines.join(' | ')}`);
    const [{ count }] = await db.select({ count: sql`count(*)::int` }).from(kempoCreditEntry);
    if(count !== 1) return fail('uninstall deleted ledger rows');
    pass('');
  },
};
