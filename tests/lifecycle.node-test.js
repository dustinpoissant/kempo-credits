import { and, eq, sql } from 'drizzle-orm';
import { groupPermission, permission } from 'kempo/server/db/schema.js';
import install from '../install.js';
import update from '../update.js';
import uninstall from '../uninstall.js';
import { INDEXES } from '../server/db/indexes.js';
import { kempoCreditEntry } from '../server/db/schema.js';
import grantCredits from '../server/utils/ledger/grant.js';
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

const canEveryoneBuy = async () => {
  const rows = await db.select().from(groupPermission)
    .where(and(eq(groupPermission.groupName, 'system:Users'), eq(groupPermission.permissionName, 'credits:purchase')));
  return rows.length;
};

const forgetPurchasePermission = async () => {
  await db.delete(groupPermission).where(eq(groupPermission.permissionName, 'credits:purchase'));
  await db.delete(permission).where(eq(permission.name, 'credits:purchase'));
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

/*
  Leaves the database as a first install would: the cases above take credits:purchase away on
  purpose, and a later suite installing here should not inherit that decision.
*/
export const afterAll = async () => {
  await forgetPurchasePermission();
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
    const [, granted] = await grantCredits({ userId: user, amount: 10, kind: 'promo', reason: 'test', idempotencyKey: 'same' });
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

  'install gives every user credits:purchase the first time, and never again': async ({ pass, fail }) => {
    await forgetPurchasePermission();

    await quietly(install);
    if(await canEveryoneBuy() !== 1) return fail('a first install did not let signed-in users buy');

    await quietly(install);
    if(await canEveryoneBuy() !== 1) return fail('installing twice granted it twice');

    // The site takes it away — to sell only to members, say.
    await db.delete(groupPermission).where(eq(groupPermission.permissionName, 'credits:purchase'));

    await quietly(update);
    if(await canEveryoneBuy()) return fail('an update gave it back');
    await quietly(install);
    if(await canEveryoneBuy()) return fail('a reinstall gave it back');
    pass('');
  },

  'update is safe to run any number of times': async ({ pass, fail }) => {
    await quietly(update);
    await quietly(update);
    const indexes = await existingIndexes();
    if(INDEXES.some(({ name }) => !indexes.has(name))) return fail('an index went missing');
    pass('');
  },

  'uninstall deletes nothing, and says how many bought credits are at stake': async ({ pass, fail }) => {
    await purge();
    const user = freshUser();
    await grantCredits({ userId: user, amount: 700, kind: 'paid', reason: 'purchase', idempotencyKey: key() });

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

    if(!lines.some(line => line.includes('700'))) return fail(`it did not mention the 700 paid credits: ${lines.join(' | ')}`);
    const [{ count }] = await db.select({ count: sql`count(*)::int` }).from(kempoCreditEntry);
    if(count !== 1) return fail('uninstall deleted ledger rows');
    pass('');
  },
};
