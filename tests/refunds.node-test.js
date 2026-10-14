import { createPack } from '../server/utils/packs/store.js';
import { getPurchase } from '../server/utils/purchases/store.js';
import { checkRefund, refundableFor, refundPurchase } from '../server/utils/purchases/refund.js';
import grantCredits from '../server/utils/ledger/grant.js';
import spendCredits from '../server/utils/ledger/spend.js';
import reverseSpend from '../server/utils/ledger/reverse.js';
import { getBalance } from '../server/utils/ledger/read.js';
import { freshUser, invariant, key, purge } from './helpers/ledger.js';
import {
  connectStripe, deliver, disconnectStripe, purgePayments, registerCreditHooks, startedPurchase, stripeEvent, unregisterCreditHooks,
} from './helpers/payments.js';

/*
  The refund rule: spent credits are never refunded as money. A purchase is refundable only as far as
  the buyer still holds credits to give back, and when something was spent on a thing the buyer never
  received, an administrator gives those credits back first and the purchase becomes refundable.

  Nothing here reaches the processor: what is refundable is worked out, and a refund over it refused,
  before the processor is asked; refunds themselves arrive the way the processor sends them, as
  signed webhooks (see helpers/payments.js).
*/

let pack;

const buy = async userId => {
  const { purchase, payment } = await startedPurchase({ userId, pack });
  await deliver(stripeEvent.succeeded(payment));
  return { purchase, payment };
};

const spend = (userId, amount, idempotencyKey = key()) => spendCredits({
  userId, amount, reason: 'feature', reference: { owner: 'test', ref: idempotencyKey }, idempotencyKey,
});

const refundable = async purchaseId => (await refundableFor({ purchaseId }))[1];

export const beforeAll = async () => {
  await purge();
  await purgePayments();
  await registerCreditHooks();
  await connectStripe();
  [, pack] = await createPack({ name: 'Starter', credits: 500, price: 499, currency: 'usd' });
};

export const afterAll = async () => {
  await unregisterCreditHooks();
  await disconnectStripe();
  await purgePayments();
  await purge();
};

export default {
  'a purchase with nothing spent is refundable in full': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase } = await buy(user);
    const result = await refundable(purchase.id);
    if(result.credits !== 500 || result.amount !== 499 || result.spent !== 0) return fail(JSON.stringify(result));
    pass('');
  },

  'spent credits are not refundable; what is left is': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase } = await buy(user);
    await spend(user, 300);

    const result = await refundable(purchase.id);
    // 200 of 500 credits left: $4.99 × 2/5 = $1.996, rounded down.
    if(result.credits !== 200 || result.amount !== 199 || result.spent !== 300) return fail(JSON.stringify(result));
    pass('');
  },

  'putting the spent credits back makes the purchase refundable again — by reversing the spend': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase } = await buy(user);
    const spent = key();
    await spend(user, 300, spent);
    await reverseSpend({ userId: user, idempotencyKey: spent, note: 'the boost never ran' });

    const result = await refundable(purchase.id);
    if(result.credits !== 500 || result.amount !== 499) return fail(JSON.stringify(result));
    pass('');
  },

  '…or by simply giving the user credits': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase } = await buy(user);
    await spend(user, 300);
    await grantCredits({ userId: user, amount: 300, kind: 'promo', reason: 'promo', note: 'the boost never ran', idempotencyKey: key() });

    const result = await refundable(purchase.id);
    if(result.credits !== 500 || result.amount !== 499) return fail(JSON.stringify(result));
    pass('');
  },

  'refunding more than is refundable is refused before the processor is asked': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase } = await buy(user);
    await spend(user, 300);

    const [over] = await refundPurchase({ purchaseId: purchase.id, amount: 300, reason: 'test' });
    if(over?.code !== 409 || over.refundable?.amount !== 199) return fail(`asking for 300: ${JSON.stringify(over)}`);

    await spend(user, 200);
    const [none] = await refundPurchase({ purchaseId: purchase.id, reason: 'test' });
    if(none?.code !== 409 || !/spent/.test(none.msg)) return fail(`with everything spent: ${JSON.stringify(none)}`);

    const [noReason] = await refundPurchase({ purchaseId: purchase.id });
    if(noReason?.code !== 400) return fail('a refund with no reason was accepted');
    pass('');
  },

  'the guard on Payments refuses a refund of spent credits and passes one that is covered': async ({ pass, fail }) => {
    const user = freshUser();
    const { payment } = await buy(user);
    await spend(user, 300);
    const paid = { ...payment, status: 'succeeded', amountCaptured: 499, amountRefunded: 0 };

    const [whole] = await checkRefund({ payment: paid, amount: 499 });
    if(whole?.code !== 409) return fail(`a full refund was allowed: ${JSON.stringify(whole)}`);
    const [everything] = await checkRefund({ payment: paid });
    if(everything?.code !== 409) return fail('a refund with no amount (everything left) was allowed');
    const [covered, allowed] = await checkRefund({ payment: paid, amount: 199 });
    if(covered || !allowed.allowed) return fail(`a covered refund was refused: ${JSON.stringify(covered)}`);
    const [, other] = await checkRefund({ payment: { ...paid, owner: 'someone-else' }, amount: 499 });
    if(!other?.allowed) return fail('a payment for something other than credits was refused');
    pass('');
  },

  'partial refunds never pay out more than the credits they took back': async ({ pass, fail }) => {
    const user = freshUser();
    const { purchase, payment } = await buy(user);
    const spent = key();
    await spend(user, 300, spent);

    // What is refundable now, refunded the way the processor reports it.
    await deliver(stripeEvent.refunded(payment, 199, 199));
    const [, balance] = await getBalance({ userId: user });
    if(balance.total !== 0 || balance.owed !== 0) return fail(`after refunding the unspent part: ${JSON.stringify(balance)}`);
    if((await refundable(purchase.id)).amount !== 0) return fail('more was refundable with every remaining credit gone');

    // The spend is put right, and the rest of the purchase becomes refundable.
    await reverseSpend({ userId: user, idempotencyKey: spent, note: 'never delivered' });
    const rest = await refundable(purchase.id);
    if(rest.amount !== 300 || rest.credits !== 300) return fail(`after reversing: ${JSON.stringify(rest)}`);

    await deliver(stripeEvent.refunded(payment, 300, 499));
    const [, after] = await getPurchase({ purchaseId: purchase.id });
    if(after.status !== 'refunded' || after.creditsClawedBack !== 500 || after.shortfall !== 0) {
      return fail(`purchase is ${after.status}, ${after.creditsClawedBack} back, short ${after.shortfall}`);
    }
    const [, final] = await getBalance({ userId: user });
    if(final.total !== 0 || final.owed !== 0) return fail(`ended at ${JSON.stringify(final)}`);
    const problem = await invariant(user);
    if(problem) return fail(problem);
    pass('$1.99 then $3.00: $4.99 for 500 credits, nothing owed');
  },
};
