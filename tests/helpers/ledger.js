import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { eq, like } from 'drizzle-orm';
import { createHook, setSetting, deleteSetting, clearHandlerCache } from 'kempo/server/sdk.js';
import { hook, setting } from 'kempo/server/db/schema.js';
import {
  kempoCreditClaim, kempoCreditClaimRedemption, kempoCreditEntry, kempoCreditLot, kempoCreditPack, kempoCreditPurchase,
} from '../../server/db/schema.js';
import { auditAccount, getBalance } from '../../server/utils/ledger/read.js';
import { db } from './db.js';

/*
  What the ledger suites share: fresh users, a reset, the invariant check, and a record of the hooks
  that fired.
*/

const here = path.dirname(fileURLToPath(import.meta.url));

export const freshUser = () => `test-user-${crypto.randomBytes(6).toString('hex')}`;

export const key = () => crypto.randomUUID();

/*
  Empties this extension's tables and puts its settings back to their defaults, so no suite runs on
  what another left behind — on a real database the rows outlive the run.
*/
export const purge = async () => {
  await db.delete(setting).where(like(setting.name, 'kempo-credits:%'));
  await db.delete(kempoCreditEntry);
  await db.delete(kempoCreditLot);
  await db.delete(kempoCreditClaimRedemption);
  await db.delete(kempoCreditClaim);
  await db.delete(kempoCreditPurchase);
  await db.delete(kempoCreditPack);
};

/*
  The invariant the plan names, checked after every operation a suite makes: each lot's `remaining`
  is the sum of its entries, each lot was opened by one grant of its amount, and the balance is the
  sum of the lots. Returns the problem as text, or null.
*/
export const invariant = async userId => {
  const [error, audit] = await auditAccount({ userId });
  if(error) return `audit failed: ${error.msg}`;
  if(!audit.ok) return audit.problems.join('; ');

  const [balanceError, balance] = await getBalance({ userId });
  if(balanceError) return `balance failed: ${balanceError.msg}`;

  const lots = await db.select().from(kempoCreditLot).where(eq(kempoCreditLot.userId, userId));
  const sum = lots.reduce((total, lot) => total + lot.remaining, 0);
  if(balance.total !== sum) return `balance says ${balance.total} but the lots add up to ${sum}`;
  if(balance.paid + balance.promo !== balance.total) return `paid ${balance.paid} + promo ${balance.promo} is not the total ${balance.total}`;

  return null;
};

/*
  Hooks. A fixture module per event appends what it was given to a list on globalThis, and the hook
  rows point at those modules by absolute path, which triggerHook imports as-is.
*/
export const HOOK_EVENTS = ['credits:granted', 'credits:spent', 'credits:reversed', 'credits:clawed-back', 'credits:low'];

export const listenToHooks = async () => {
  await db.delete(hook).where(like(hook.owner, 'kempo-credits-test%'));
  for(const event of HOOK_EVENTS){
    const file = path.join(here, '..', 'fixtures', 'hooks', `${event.split(':')[1]}.js`);
    await createHook({ owner: 'kempo-credits-test', event, callback: file });
  }
  clearHandlerCache();
  globalThis.kempoCreditsHooks = [];
};

export const stopListening = async () => {
  await db.delete(hook).where(like(hook.owner, 'kempo-credits-test%'));
  clearHandlerCache();
};

export const heard = (event, userId) => (globalThis.kempoCreditsHooks || [])
  .filter(call => call.event === event && (!userId || call.data.userId === userId));

export const withSetting = async (name, value, type, run) => {
  await setSetting('kempo-credits', name, value, type, false, null);
  try {
    return await run();
  } finally {
    await deleteSetting('kempo-credits', name).catch(() => {});
  }
};
