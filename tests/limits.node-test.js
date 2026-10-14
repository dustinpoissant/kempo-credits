import { and, eq } from 'drizzle-orm';
import { kempoCreditPurchase } from '../server/db/schema.js';
import { createPack } from '../server/utils/packs/store.js';
import startPurchase from '../server/utils/purchases/start.js';
import { getPurchase, insertPurchase } from '../server/utils/purchases/store.js';
import { db } from './helpers/db.js';
import { freshUser, purge, withSetting } from './helpers/ledger.js';
import {
  connectStripe, deliver, disconnectStripe, purgePayments, registerCreditHooks, startedPurchase, stripeEvent, unregisterCreditHooks,
} from './helpers/payments.js';

/*
  The card-testing defences: rate limits per user, per address and for the whole site, and the
  cool-down after repeated declines. Each limit is shown both refusing and — just as important —
  not refusing the ordinary buyer next to it.

  An attempt that gets past every limit goes on to open a payment; no processor is connected here,
  so that is a 409 "not connected". A 409 therefore means "the limits let it through", and a 429
  means they did not.
*/

let pack;

const attempt = (userId, ip) => startPurchase({ userId, packId: pack.id, ip });

const earlierAttempts = async (count, values) => {
  for(let index = 0; index < count; index++){
    await insertPurchase({ status: 'canceled', packId: pack.id, credits: 1, ...values });
  }
};

const blockedRows = (userId, reason) => db.select().from(kempoCreditPurchase)
  .where(and(eq(kempoCreditPurchase.userId, userId), eq(kempoCreditPurchase.status, 'blocked'), eq(kempoCreditPurchase.blockedReason, reason)));

export const beforeAll = async () => {
  await purge();
  await purgePayments();
  await disconnectStripe();
  [, pack] = await createPack({ name: 'Tiny', credits: 100, price: 99, currency: 'usd' });
};

export const afterAll = async () => {
  await unregisterCreditHooks();
  await disconnectStripe();
  await purgePayments();
  await purge();
};

export default {
  'one account gets its hourly attempts, then is refused and logged': async ({ pass, fail }) => {
    const user = freshUser();
    await earlierAttempts(9, { userId: user, ip: '192.0.2.1' });

    const [allowed] = await attempt(user, '192.0.2.1');
    if(allowed?.code !== 409) return fail(`the tenth attempt gave ${allowed?.code}: ${allowed?.msg}`);

    const [refused] = await attempt(user, '192.0.2.1');
    if(refused?.code !== 429 || refused.reason !== 'user-rate') return fail(`the eleventh gave ${JSON.stringify(refused)}`);
    if(!(refused.retryAfter > 0 && refused.retryAfter <= 3600)) return fail(`retryAfter is ${refused.retryAfter}`);
    if((await blockedRows(user, 'user-rate')).length !== 1) return fail('the refusal was not logged');

    const [again] = await attempt(user, '192.0.2.1');
    if(again?.code !== 429) return fail('a refused attempt let the next one through');
    if((await blockedRows(user, 'user-rate')).length !== 2) return fail('the second refusal was not logged');

    const [other] = await attempt(freshUser(), '192.0.2.1');
    if(other?.code !== 409) return fail(`a different account on the same address was refused: ${other?.msg}`);
    pass('');
  },

  'attempts an hour old no longer count': async ({ pass, fail }) => {
    const user = freshUser();
    const old = new Date(Date.now() - 61 * 60000);
    await earlierAttempts(10, { userId: user, createdAt: old, updatedAt: old });

    const [allowed] = await attempt(user);
    if(allowed?.code !== 409) return fail(`gave ${allowed?.code}: ${allowed?.msg}`);
    pass('');
  },

  'one address is limited across every account using it': async ({ pass, fail }) => {
    const ip = '192.0.2.50';
    for(let index = 0; index < 20; index++) await earlierAttempts(1, { userId: freshUser(), ip });

    const [refused] = await attempt(freshUser(), ip);
    if(refused?.code !== 429 || refused.reason !== 'ip-rate') return fail(`gave ${JSON.stringify(refused)}`);

    const [elsewhere] = await attempt(freshUser(), '192.0.2.51');
    if(elsewhere?.code !== 409) return fail('a different address was refused');
    pass('');
  },

  'the whole site has a ceiling, and the setting moves it': async ({ pass, fail }) => {
    await withSetting('purchase_limit_global', 3, 'number', async () => {
      await db.delete(kempoCreditPurchase);
      await earlierAttempts(3, { userId: freshUser() });
      const [refused] = await attempt(freshUser(), '192.0.2.99');
      if(refused?.code !== 429 || refused.reason !== 'global-rate') return fail(`gave ${JSON.stringify(refused)}`);
      pass('');
    });
  },

  'refused attempts do not count towards the limits': async ({ pass, fail }) => {
    await db.delete(kempoCreditPurchase);
    const user = freshUser();
    await earlierAttempts(30, { userId: user, ip: '192.0.2.77', status: 'blocked', blockedReason: 'user-rate' });

    const [allowed] = await attempt(user, '192.0.2.77');
    if(allowed?.code !== 409) return fail(`gave ${allowed?.code}: ${allowed?.msg}`);
    pass('');
  },

  /*
    The one case here that reaches the network: on the third decline the handler cancels the payment
    at the processor, and the suite's fake key gets a 401 back (or no answer, offline). Either way the
    purchase is blocked, which is what is asserted — a cancel that fails is logged and does not
    un-block anything.
  */
  'a decline and a retry is a customer; three declines is a cool-down': async ({ pass, fail }) => {
    await connectStripe();
    await registerCreditHooks();
    const user = freshUser();
    const ip = '192.0.2.120';
    const { purchase, payment } = await startedPurchase({ userId: user, pack, ip });

    await deliver(stripeEvent.failed(payment, 'Your card was declined.'));
    const [, once] = await getPurchase({ purchaseId: purchase.id });
    if(once.failures !== 1 || once.status !== 'pending') return fail(`after one decline: ${once.failures} failures, ${once.status}`);

    await disconnectStripe();
    const [retry] = await attempt(user, ip);
    if(retry?.code !== 409) return fail(`a retry after one decline was refused: ${retry?.msg}`);

    await connectStripe();
    await deliver(stripeEvent.failed(payment, 'Your card has insufficient funds.'));
    await deliver(stripeEvent.failed(payment, 'Your card’s security code is incorrect.'));

    const [, stopped] = await getPurchase({ purchaseId: purchase.id });
    if(stopped.status !== 'blocked' || stopped.blockedReason !== 'user-declines') return fail(`after three declines: ${stopped.status}, ${stopped.blockedReason}`);

    await disconnectStripe();
    const [refused] = await attempt(user, ip);
    if(refused?.code !== 429 || refused.reason !== 'user-declines') return fail(`a new attempt gave ${JSON.stringify(refused)}`);

    const [otherAccount] = await attempt(freshUser(), ip);
    if(otherAccount?.code !== 429 || otherAccount.reason !== 'ip-declines') return fail(`another account on that address gave ${JSON.stringify(otherAccount)}`);
    pass('');
  },

  'the cool-down ends': async ({ pass, fail }) => {
    const user = freshUser();
    const old = new Date(Date.now() - 61 * 60000);
    await insertPurchase({ userId: user, status: 'canceled', packId: pack.id, credits: 1, failures: 5, lastFailedAt: old, createdAt: old, updatedAt: old });

    const [allowed] = await attempt(user, '192.0.2.200');
    if(allowed?.code !== 409) return fail(`gave ${allowed?.code}: ${allowed?.msg}`);
    pass('');
  },
};
