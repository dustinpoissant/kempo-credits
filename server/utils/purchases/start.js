import { and, eq, ne } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { cancelPayment, createPayment, getPayment, isAwaitingCustomer } from 'kempo-payments/sdk';
import { kempoCreditPurchase } from '../../db/schema.js';
import { OWNER, readConfig } from '../config/settings.js';
import { cleanText, cleanUserId, hasNulByte } from '../ledger/validate.js';
import { getPack } from '../packs/store.js';
import { REASONS, checkLimits, recordBlocked } from './limits.js';
import { priceFor } from './tax.js';
import { insertPurchase, presentForBuyer, updatePurchase } from './store.js';

/*
  Starts buying a pack: price it, record what the buyer is about to be shown, and open a payment for
  exactly that amount.

  ```js
  const [error, { purchase, clientSecret, shown }] = await startPurchase({ userId, packId, address, ip });
  ```

  The amount charged comes from the pack and, when kempo-tax is enabled, from the tax on it — never
  from the caller. A pack the administrator has disabled cannot be bought. The abuse limits are
  checked before anything else, and an attempt they refuse is logged and never reaches the processor.

  The browser mounts kempo-payments' `<k-pay-form>` with `clientSecret`. Nothing it says afterwards
  is believed: the credits are granted when kempo-payments fires `payment:succeeded`, which comes
  from the processor (see payments.js).

  A buyer who starts a second purchase has abandoned the first, so a first one still waiting for a
  card is cancelled at the processor. That keeps a buyer to one payment that can be tried at a time,
  which is one fewer thing to try stolen cards against.
*/
export default async ({ userId, packId, address = null, ip = null, userAgent = null, email = null } = {}) => {
  const [userError, user] = cleanUserId(userId);
  if(userError) return [{ code: 401, msg: 'Sign in to buy credits' }, null];
  if(typeof packId !== 'string' || !packId) return [{ code: 400, msg: 'Choose a pack' }, null];
  if(hasNulByte(address, ip, userAgent, email)) return [{ code: 400, msg: 'The purchase details cannot contain null characters' }, null];

  const [, agent] = cleanText(typeof userAgent === 'string' ? userAgent.slice(0, 300) : null, 'User agent', { max: 300 });
  const config = await readConfig();
  const now = new Date();

  const [limitError, refused] = await checkLimits({ userId: user, ip, config, now });
  if(limitError) return [limitError, null];
  if(refused){
    await recordBlocked({ userId: user, packId, ip, userAgent: agent, reason: refused.reason, now });
    return [{
      code: 429,
      msg: `${REASONS[refused.reason]}. Try again in ${Math.ceil(refused.retryAfter / 60)} minute${refused.retryAfter > 60 ? 's' : ''}.`,
      reason: refused.reason,
      retryAfter: refused.retryAfter,
    }, null];
  }

  const [packError, pack] = await getPack({ packId });
  if(packError) return [packError.code === 404 ? { code: 404, msg: 'That pack does not exist' } : packError, null];
  if(!pack.enabled) return [{ code: 409, msg: 'That pack is not on sale' }, null];

  const [priceError, price] = await priceFor({ pack, address, config });
  if(priceError) return [priceError, null];

  /*
    Exactly what the buyer is shown before they pay, kept with the purchase. A dispute is answered
    with this: the price, the tax, the total and the refund policy, as they were on the day.
  */
  const shown = {
    pack: { id: pack.id, name: pack.name, credits: pack.credits },
    currency: pack.currency,
    subtotal: price.subtotal,
    tax: price.tax,
    total: price.total,
    includesTax: price.includesTax,
    taxed: price.enabled,
    refundPolicy: config.refundPolicy,
    shownAt: now.toISOString(),
  };

  const [insertError, purchase] = await insertPurchase({
    userId: user,
    status: 'pending',
    packId: pack.id,
    packName: pack.name,
    credits: pack.credits,
    currency: pack.currency,
    subtotal: price.subtotal,
    tax: price.tax,
    total: price.total,
    includesTax: price.includesTax,
    taxCalculationId: price.calculationId,
    ip,
    userAgent: agent,
    shown,
    createdAt: now,
    updatedAt: now,
  });
  if(insertError) return [insertError, null];

  await abandonEarlier(user, purchase.id);

  const [paymentError, started] = await createPayment({
    amount: price.total,
    currency: pack.currency,
    description: `${pack.credits} credits — ${pack.name}`,
    metadata: { kempoCreditsPackId: pack.id },
    owner: OWNER,
    reference: purchase.id,
    userId: user,
    customerEmail: email,
  });

  if(paymentError){
    await updatePurchase(purchase.id, { status: 'failed', lastError: paymentError.msg });
    return [paymentError, null];
  }

  const [updateError, saved] = await updatePurchase(purchase.id, { paymentId: started.payment.id });
  if(updateError) return [updateError, null];

  return [null, { purchase: presentForBuyer(saved), clientSecret: started.clientSecret, paymentId: started.payment.id, shown }];
};

/*
  Cancels the buyer's earlier purchases that are still waiting for a card. One that has moved on —
  paid, processing, authorised — is left alone: the buyer may well have paid it in another tab.
*/
const abandonEarlier = async (userId, keep) => {
  let earlier = [];
  try {
    earlier = await db.select().from(kempoCreditPurchase).where(and(
      eq(kempoCreditPurchase.userId, userId),
      eq(kempoCreditPurchase.status, 'pending'),
      ne(kempoCreditPurchase.id, keep),
    ));
  } catch {
    return;
  }

  for(const purchase of earlier){
    if(!purchase.paymentId){
      await updatePurchase(purchase.id, { status: 'canceled', lastError: 'Replaced by a newer purchase' });
      continue;
    }

    const [loadError, payment] = await getPayment(purchase.paymentId);
    if(loadError || !isAwaitingCustomer(payment.status)) continue;

    const [cancelError] = await cancelPayment(payment.id);
    if(!cancelError) await updatePurchase(purchase.id, { status: 'canceled', lastError: 'Replaced by a newer purchase' });
  }
};
