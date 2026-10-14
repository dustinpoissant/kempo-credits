import { eq } from 'drizzle-orm';
import { getPayment } from 'kempo-payments/sdk';
import { kempoCreditPurchase } from '../server/db/schema.js';
import { createPack, updatePack } from '../server/utils/packs/store.js';
import startPurchase from '../server/utils/purchases/start.js';
import { getPurchase } from '../server/utils/purchases/store.js';
import { checkPurchase, creditsForRefund, reconcilePurchase } from '../server/utils/purchases/payments.js';
import spendCredits from '../server/utils/ledger/spend.js';
import { getBalance, listEntries } from '../server/utils/ledger/read.js';
import { db } from './helpers/db.js';
import { freshUser, invariant, key, purge } from './helpers/ledger.js';
import {
  connectStripe, deliver, disconnectStripe, kempoPayment, purgePayments, registerCreditHooks, startedPurchase, stripeEvent, unregisterCreditHooks,
} from './helpers/payments.js';

/*
  Buying a pack, from the price to the refund, through kempo-payments' real webhook receiver. See
  helpers/payments.js for how that runs without a processor.
*/

let pack;

const balanceOf = async userId => (await getBalance({ userId }))[1];

const succeed = async (payment, options) => {
  const [error, result] = await deliver(stripeEvent.succeeded(payment, options));
  if(error) throw new Error(`webhook refused: ${error.msg}`);
  return result;
};

export const beforeAll = async () => {
  await purge();
  await purgePayments();
  await registerCreditHooks();
  [, pack] = await createPack({ name: 'Starter', credits: 500, price: 499, currency: 'usd' });
};

export const afterAll = async () => {
  await unregisterCreditHooks();
  await disconnectStripe();
  await purgePayments();
  await purge();
};

export default {
  'a purchase is priced from the pack, and records what the buyer was shown': async ({ pass, fail }) => {
    await disconnectStripe();
    const user = freshUser();

    const [error] = await startPurchase({ userId: user, packId: pack.id, ip: '198.51.100.1' });
    if(error?.code !== 409) return fail(`with no processor connected, expected a 409, got ${error?.code ?? 'success'}`);

    const [row] = await db.select().from(kempoCreditPurchase).where(eq(kempoCreditPurchase.userId, user));
    if(!row) return fail('the attempt was not recorded');
    if(row.status !== 'failed' || !row.lastError?.includes('not connected')) return fail(`status ${row.status}: ${row.lastError}`);
    if(row.total !== 499 || row.credits !== 500 || row.tax !== 0) return fail(`priced at ${row.total} for ${row.credits}`);
    if(row.shown?.total !== 499 || !row.shown.refundPolicy || row.shown.pack.credits !== 500) return fail(`shown: ${JSON.stringify(row.shown)}`);
    if(row.ip !== '198.51.100.1') return fail('the address was not kept for the limits');
    pass('');
  },

  'a disabled pack, an unknown pack, and nobody signed in cannot buy': async ({ pass, fail }) => {
    const [, hidden] = await createPack({ name: 'Old', credits: 10, price: 99, currency: 'usd' });
    await updatePack({ packId: hidden.id, enabled: false });

    const [disabled] = await startPurchase({ userId: freshUser(), packId: hidden.id });
    if(disabled?.code !== 409) return fail(`a disabled pack gave ${disabled?.code ?? 'success'}`);
    const [unknown] = await startPurchase({ userId: freshUser(), packId: 'pack_nope' });
    if(unknown?.code !== 404) return fail(`an unknown pack gave ${unknown?.code ?? 'success'}`);
    const [anonymous] = await startPurchase({ packId: pack.id });
    if(anonymous?.code !== 401) return fail(`no user gave ${anonymous?.code ?? 'success'}`);
    pass('');
  },

  'a signed payment_intent.succeeded grants the pack, once, however often it arrives': async ({ pass, fail }) => {
    await connectStripe();
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });

    const event = stripeEvent.succeeded(payment);
    await deliver(event);
    const [, again] = await deliver(event);
    if(!again?.duplicate) return fail('kempo-payments did not see the redelivery as a duplicate');
    await succeed(payment);  // a different event about the same payment

    const balance = await balanceOf(user);
    if(balance.total !== 500 || balance.paid !== 500) return fail(`balance is ${JSON.stringify(balance)}`);
    const [, grants] = await listEntries({ userId: user, type: 'grant' });
    if(grants.total !== 1) return fail(`${grants.total} grants`);

    const [, after] = await getPurchase({ purchaseId: purchase.id });
    if(after.status !== 'paid' || !after.lotId || !after.paidAt) return fail(`purchase is ${after.status}`);
    if(grants.entries[0].referenceId !== purchase.id) return fail('the grant does not point at the purchase');

    const problem = await invariant(user);
    if(problem) return fail(problem);
    pass('');
  },

  'nothing is granted until the processor says so': async ({ pass, fail }) => {
    await disconnectStripe();
    const user = freshUser();
    const { purchase } = await startedPurchase({ userId: user, pack });

    if((await balanceOf(user)).total !== 0) return fail('credits appeared before payment');

    const [stranger] = await checkPurchase({ purchaseId: purchase.id, userId: freshUser() });
    if(stranger?.code !== 404) return fail('another user could look at the purchase');

    const [, checked] = await checkPurchase({ purchaseId: purchase.id, userId: user });
    if(checked.status !== 'pending') return fail(`checking moved it to ${checked.status}`);
    if((await balanceOf(user)).total !== 0) return fail('checking granted credits for an unpaid payment');
    pass('');
  },

  'a payment for a different amount grants nothing': async ({ pass, fail }) => {
    await connectStripe();
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });

    // The row kempo-payments keeps is edited to a smaller amount: what a bug upstream would look like.
    await db.update(kempoPayment).set({ amount: 99 }).where(eq(kempoPayment.id, payment.id));
    await succeed({ ...payment, amount: 99 });

    if((await balanceOf(user)).total !== 0) return fail('a pack was granted for less than its price');
    const [, after] = await getPurchase({ purchaseId: purchase.id });
    if(!after.lastError?.includes('priced at 499')) return fail(`the purchase says ${after.lastError}`);
    pass('');
  },

  'a full refund takes the whole pack back': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });
    await succeed(payment);

    await deliver(stripeEvent.refunded(payment, 499));

    const [, after] = await getPurchase({ purchaseId: purchase.id });
    if(after.status !== 'refunded' || after.creditsClawedBack !== 500 || after.refundedAmount !== 499) {
      return fail(`purchase is ${after.status}, ${after.creditsClawedBack} clawed back, ${after.refundedAmount} refunded`);
    }
    if((await balanceOf(user)).total !== 0) return fail('credits remain after a full refund');
    const problem = await invariant(user);
    if(problem) return fail(problem);
    pass('');
  },

  'a refund after spending leaves the buyer owing what they spent': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });
    await succeed(payment);
    await spendCredits({ userId: user, amount: 320, reason: 'feature', reference: { owner: 'test', ref: 'x' }, idempotencyKey: key() });

    await deliver(stripeEvent.refunded(payment, 499));

    const [, after] = await getPurchase({ purchaseId: purchase.id });
    if(after.shortfall !== 320) return fail(`the purchase records a shortfall of ${after.shortfall}`);
    const balance = await balanceOf(user);
    if(balance.total !== -320 || balance.owed !== 320) return fail(`balance is ${JSON.stringify(balance)}`);

    const [blocked] = await spendCredits({ userId: user, amount: 1, reason: 'x', reference: { owner: 'test', ref: 'y' }, idempotencyKey: key() });
    if(blocked?.code !== 402) return fail('a buyer who owes could still spend');
    const problem = await invariant(user);
    if(problem) return fail(problem);
    pass('');
  },

  'partial refunds take back the refunded share, rounded up, and add up to the pack': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });
    await succeed(payment);

    await deliver(stripeEvent.refunded(payment, 100));
    const [, first] = await getPurchase({ purchaseId: purchase.id });
    // 500 credits × 100/499 = 100.2 → 101
    if(first.status !== 'partially_refunded' || first.creditsClawedBack !== 101) return fail(`after $1.00: ${first.status}, ${first.creditsClawedBack}`);

    await deliver(stripeEvent.refunded(payment, 399, 499));
    const [, second] = await getPurchase({ purchaseId: purchase.id });
    if(second.status !== 'refunded' || second.creditsClawedBack !== 500) return fail(`after the rest: ${second.status}, ${second.creditsClawedBack}`);
    if((await balanceOf(user)).total !== 0) return fail('credits remain after refunding everything in two parts');
    pass('');
  },

  'the refunded share is exact at the edges': async ({ pass, fail }) => {
    const cases = [
      [[500, 0, 499], 0],
      [[500, 499, 499], 500],
      [[500, 600, 499], 500],
      [[500, 1, 499], 2],
      [[1, 1, 1000], 1],
      [[1000000000, 1, 99999999], 11],
    ];
    for(const [args, expected] of cases){
      const actual = creditsForRefund(...args);
      if(actual !== expected) return fail(`creditsForRefund(${args.join(', ')}) is ${actual}, expected ${expected}`);
    }
    pass('');
  },

  'a refund heard before the success never grants': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });
    await db.update(kempoPayment).set({ status: 'succeeded', amountCaptured: 499 }).where(eq(kempoPayment.id, payment.id));

    await deliver(stripeEvent.refunded(payment, 499));
    await succeed(payment);

    const [, after] = await getPurchase({ purchaseId: purchase.id });
    if(after.status !== 'refunded') return fail(`purchase is ${after.status}`);
    if((await balanceOf(user)).total !== 0) return fail('credits were granted for a payment already refunded');
    pass('');
  },

  'a dispute flags the purchase and takes nothing back by itself': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });
    await succeed(payment);
    await deliver(stripeEvent.disputed(payment));

    const [, after] = await getPurchase({ purchaseId: purchase.id });
    if(!after.disputed) return fail('the purchase was not flagged');
    if((await balanceOf(user)).total !== 500) return fail('a dispute changed the balance');
    pass('');
  },

  'a cancelled payment cancels its pending purchase': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });
    await deliver({ id: `evt_cancel_${purchase.id}`, type: 'payment_intent.canceled', data: { object: { id: payment.providerRef, status: 'canceled', amount: 499, currency: 'usd', livemode: false } } });

    const [, after] = await getPurchase({ purchaseId: purchase.id });
    if(after.status !== 'canceled') return fail(`purchase is ${after.status}`);
    pass('');
  },

  /*
    Reconciling asks the processor first. With no key connected kempo-payments refuses before any
    request leaves the machine, so these stay offline and the local state is what gets applied.
  */
  'a purchase whose hook was missed is granted by reconciling it': async ({ pass, fail }) => {
    await disconnectStripe();
    const user = freshUser();
    const { purchase, payment } = await startedPurchase({ userId: user, pack });

    // The payment succeeded, but this extension never heard: no hook ran.
    await db.update(kempoPayment).set({ status: 'succeeded', amountCaptured: 499 }).where(eq(kempoPayment.id, payment.id));

    const [error, after] = await reconcilePurchase({ purchaseId: purchase.id });
    if(error) return fail(error.msg);
    if(after.status !== 'paid') return fail(`purchase is ${after.status}`);
    if((await balanceOf(user)).total !== 500) return fail('reconciling did not grant');

    const [, twice] = await reconcilePurchase({ purchaseId: purchase.id });
    if(twice.status !== 'paid' || (await balanceOf(user)).total !== 500) return fail('reconciling twice granted twice');

    const [, stored] = await getPayment(payment.id);
    if(stored.status !== 'succeeded') return fail('the payment row was disturbed');
    pass('');
  },

  'checking is throttled to one processor call every few seconds': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase } = await startedPurchase({ userId: user, pack });

    await checkPurchase({ purchaseId: purchase.id, userId: user });
    const [, first] = await getPurchase({ purchaseId: purchase.id });
    await checkPurchase({ purchaseId: purchase.id, userId: user });
    const [, second] = await getPurchase({ purchaseId: purchase.id });

    if(!first.checkedAt) return fail('the first check did not happen');
    if(new Date(second.checkedAt).getTime() !== new Date(first.checkedAt).getTime()) return fail('the second check went to the processor too');
    pass('');
  },
};
