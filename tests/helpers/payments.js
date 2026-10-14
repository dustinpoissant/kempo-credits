import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Stripe from 'stripe';
import { like } from 'drizzle-orm';
import { createHook, deleteSetting, setSetting, clearHandlerCache } from 'kempo/server/sdk.js';
import { hook } from 'kempo/server/db/schema.js';
import { receiveWebhook } from 'kempo-payments/sdk';
import { insertPurchase, updatePurchase } from '../../server/utils/purchases/store.js';
import { db } from './db.js';

/*
  Payments without a payment processor.

  kempo-payments' webhook receiver is driven with events signed exactly as Stripe signs them —
  `generateTestHeaderString` makes a real signature for a secret chosen here, and the same
  `constructEvent` production uses checks it. So a test that delivers `payment_intent.succeeded`
  exercises the whole real chain: signature, event de-duplication, kempo-payments updating its row
  and firing `payment:succeeded`, this extension's hook module, and the grant. Nothing talks to
  Stripe, and nothing is mocked.

  The one thing that does need Stripe is opening the payment, so `startedPurchase` writes the same
  two rows `startPurchase` would — a pending purchase and its payment — directly.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fromPayments = file => import(pathToFileURL(path.join(root, 'node_modules', 'kempo-payments', file)).href);

const paymentsStore = await fromPayments('server/utils/payments/store.js');
export const { kempoPayment, kempoPaymentEvent, kempoPaymentRefund } = await fromPayments('server/db/schema.js');

const SECRET = 'whsec_kempo_credits_suite';
const KEY = 'sk_test_kempo_credits_suite';

export const connectStripe = async () => {
  await setSetting('kempo-payments', 'stripe_secret_key', KEY, 'secret', false, 'test');
  await setSetting('kempo-payments', 'stripe_webhook_secret', SECRET, 'secret', false, 'test');
};

export const disconnectStripe = async () => {
  for(const name of ['stripe_secret_key', 'stripe_webhook_secret']) await deleteSetting('kempo-payments', name).catch(() => {});
};

/*
  This extension's real hook modules, registered the way kempo's installer registers them from
  kempo-config.json — except by absolute path, since there is no site node_modules to resolve
  `./hooks/…` against here.
*/
export const registerCreditHooks = async () => {
  await db.delete(hook).where(like(hook.owner, 'kempo-credits'));
  for(const event of ['succeeded', 'failed', 'canceled', 'refunded', 'disputed']){
    await createHook({ owner: 'kempo-credits', event: `payment:${event}`, callback: path.join(root, 'hooks', `payment-${event}.js`) });
  }
  clearHandlerCache();
};

export const unregisterCreditHooks = async () => {
  await db.delete(hook).where(like(hook.owner, 'kempo-credits'));
  clearHandlerCache();
};

export const purgePayments = async () => {
  await db.delete(kempoPaymentEvent);
  await db.delete(kempoPaymentRefund);
  await db.delete(kempoPayment);
};

let sequence = 0;
const id = prefix => `${prefix}_${Date.now().toString(36)}${(sequence++).toString(36)}`;

export const startedPurchase = async ({ userId, pack, ip = '203.0.113.7', total = pack.price, currency = pack.currency }) => {
  const [error, purchase] = await insertPurchase({
    userId,
    status: 'pending',
    packId: pack.id,
    packName: pack.name,
    credits: pack.credits,
    currency,
    subtotal: pack.price,
    tax: total - pack.price,
    total,
    ip,
  });
  if(error) throw new Error(error.msg);

  const [paymentError, payment] = await paymentsStore.insertPayment({
    provider: 'stripe',
    providerRef: id('pi'),
    status: 'requires_payment_method',
    amount: total,
    currency,
    owner: 'kempo-credits',
    reference: purchase.id,
    userId,
  });
  if(paymentError) throw new Error(paymentError.msg);

  const [, saved] = await updatePurchase(purchase.id, { paymentId: payment.id });
  return { purchase: saved, payment };
};

const sign = payload => new Stripe(KEY).webhooks.generateTestHeaderString({ payload, secret: SECRET });

export const deliver = event => {
  const payload = JSON.stringify(event);
  return receiveWebhook({ provider: 'stripe', payload, signature: sign(payload) });
};

const intent = (payment, extra = {}) => ({
  id: payment.providerRef,
  amount: payment.amount,
  currency: payment.currency,
  capture_method: 'automatic',
  livemode: false,
  ...extra,
});

export const stripeEvent = {
  succeeded: (payment, { amount = payment.amount, eventId = id('evt') } = {}) => ({
    id: eventId,
    type: 'payment_intent.succeeded',
    data: { object: intent(payment, { status: 'succeeded', amount, amount_received: amount }) },
  }),

  failed: (payment, message = 'Your card was declined.') => ({
    id: id('evt'),
    type: 'payment_intent.payment_failed',
    data: { object: intent(payment, { status: 'requires_payment_method', last_payment_error: { message } }) },
  }),

  refunded: (payment, amount, total = amount) => ({
    id: id('evt'),
    type: 'charge.refunded',
    data: { object: { id: id('ch'), payment_intent: payment.providerRef, amount_refunded: total, refunds: { data: [{ id: id('re'), amount, currency: payment.currency, status: 'succeeded' }] } } },
  }),

  disputed: payment => ({
    id: id('evt'),
    type: 'charge.dispute.created',
    data: { object: { id: id('dp'), payment_intent: payment.providerRef, reason: 'fraudulent' } },
  }),
};
