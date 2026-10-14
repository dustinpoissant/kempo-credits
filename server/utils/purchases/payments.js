import { and, eq, gte, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { cancelPayment, getPayment, isAwaitingCustomer, syncPayment } from 'kempo-payments/sdk';
import { kempoCreditPurchase } from '../../db/schema.js';
import { OWNER, readConfig } from '../config/settings.js';
import grantCredits from '../ledger/grant.js';
import { clawBackGrant, findLot, grantState } from '../ledger/clawback.js';
import { notifyAdmins } from '../ledger/events.js';
import { REASONS } from './limits.js';
import { taxModule } from './tax.js';
import { getPurchase, updatePurchase } from './store.js';

/*
  What happens to a purchase when kempo-payments reports on its payment. Each of these is called
  from a hook in hooks/, with the payload kempo-payments fires, and each is safe to call any number
  of times with the same payload: processors redeliver, and a buyer's "check again" re-reads.

  The rule all of this follows: **credits are granted on the processor's word, never the
  browser's.** The browser saying a card went through moves the buyer to a thank-you screen and
  nothing else; `payment:succeeded` comes from the processor's signed webhook (or a re-read of the
  processor), and only that grants.
*/

const ours = payment => payment?.owner === OWNER && typeof payment.reference === 'string' && payment.reference.startsWith('pur_');

const ignored = [null, { ignored: true }];

/*
  The credits a refund of this much takes back: the same share of the pack as of the money,
  rounded up, so a refund never leaves the buyer holding a fraction of a credit the site paid back
  for. Worked in BigInt because credits times minor units can pass 2^53.
*/
export const creditsForRefund = (credits, refunded, captured) => {
  if(refunded >= captured) return credits;
  if(refunded <= 0) return 0;
  return Number((BigInt(credits) * BigInt(refunded) + BigInt(captured) - 1n) / BigInt(captured));
};

/*
  Credits already taken back for a purchase's grant — wherever they were taken from, since a refund
  takes from the user's other credits once the purchase's own are used up.
*/
const clawedSoFar = async lotId => {
  if(!lotId) return 0;
  const [error, lot] = await findLot({ lotId });
  if(error) return 0;
  return (await grantState(db, lot)).clawed;
};

/*
  The tax side of a sale, recorded once the money is in. A failure here never undoes the grant —
  the buyer paid and has their credits — but it is kept on the purchase and an administrator is told,
  because a sale missing from the tax ledger is a return that is short.
*/
const recordTax = async purchase => {
  if(!purchase.taxCalculationId || purchase.taxTransactionId) return purchase;

  const tax = await taxModule();
  const [error, sale] = tax
    ? await tax.recordTransaction({ calculationId: purchase.taxCalculationId, reference: `${OWNER}:${purchase.id}` })
    : [{ msg: 'kempo-tax was disabled before the sale could be recorded' }, null];

  if(error){
    await notifyAdmins({
      title: 'A credit sale is missing from the tax ledger',
      message: `Purchase ${purchase.id} was paid, but recording its tax failed: ${error.msg}`,
      dedupeKey: `tax:${purchase.id}`,
      url: `/admin/extension/kempo-credits/?tab=purchases&purchase=${purchase.id}`,
    });
    const [, updated] = await updatePurchase(purchase.id, { taxError: error.msg });
    return updated || purchase;
  }

  const [, updated] = await updatePurchase(purchase.id, { taxTransactionId: sale.transactionId, taxError: null });
  return updated || purchase;
};

export const onPaymentSucceeded = async ({ payment } = {}) => {
  if(!ours(payment)) return ignored;

  const [loadError, purchase] = await getPurchase({ purchaseId: payment.reference });
  if(loadError) return [loadError, null];
  if(purchase.paymentId && purchase.paymentId !== payment.id) return [{ code: 409, msg: 'That payment is not the one this purchase was started with' }, null];

  /*
    Refunded before the success was ever heard — webhooks are not delivered in order. There is
    nothing to grant: the money has already gone back.
  */
  if(purchase.status === 'refunded') return [null, { purchase, granted: null }];

  /*
    The processor took the amount this site asked for, or this would not be our payment — but a
    payment row edited by hand, or a bug anywhere upstream, is not a reason to grant a pack for less
    than its price. Refused loudly instead.
  */
  if(payment.amount !== purchase.total || payment.currency !== purchase.currency){
    await updatePurchase(purchase.id, { lastError: `Paid ${payment.amount} ${payment.currency}, but the purchase was priced at ${purchase.total} ${purchase.currency}` });
    await notifyAdmins({
      title: 'A credit purchase was paid the wrong amount',
      message: `Purchase ${purchase.id} was priced at ${purchase.total} ${purchase.currency} and paid ${payment.amount} ${payment.currency}. No credits were granted.`,
      level: 'error',
      dedupeKey: `amount:${purchase.id}`,
      url: `/admin/extension/kempo-credits/?tab=purchases&purchase=${purchase.id}`,
    });
    return [{ code: 409, msg: 'The amount paid does not match the purchase' }, null];
  }

  const [grantError, granted] = await grantCredits({
    userId: purchase.userId,
    amount: purchase.credits,
    kind: 'paid',
    reason: 'purchase',
    reference: { owner: OWNER, ref: purchase.id },
    idempotencyKey: `payment:${payment.id}`,
  });
  if(grantError) return [grantError, null];

  const [updateError, updated] = await updatePurchase(purchase.id, {
    status: ['partially_refunded'].includes(purchase.status) ? purchase.status : 'paid',
    paymentId: payment.id,
    lotId: granted.lot.id,
    paidAt: purchase.paidAt || new Date(),
    blockedReason: null,
    lastError: null,
  });
  if(updateError) return [updateError, null];

  return [null, { purchase: await recordTax(updated), granted }];
};

/*
  One decline. Counted towards the cool-down, and once this purchase, this buyer or this address
  has had too many, the payment is cancelled at the processor — otherwise the same open payment
  could have card after card tried against it from the browser, none of which ever passes through
  here.
*/
export const onPaymentFailed = async ({ payment, error } = {}) => {
  if(!ours(payment)) return ignored;

  const [loadError, purchase] = await getPurchase({ purchaseId: payment.reference });
  if(loadError) return [loadError, null];

  const now = new Date();
  const [updateError, updated] = await updatePurchase(purchase.id, {
    failures: purchase.failures + 1,
    lastFailedAt: now,
    lastError: typeof error === 'string' && error ? error.slice(0, 500) : 'The payment was declined',
  });
  if(updateError) return [updateError, null];

  const config = await readConfig();
  const since = new Date(now.getTime() - config.failedPaymentCooldownMinutes * 60000);
  const declines = async who => {
    const [row] = await db.select({ total: sql`coalesce(sum(${kempoCreditPurchase.failures}), 0)::int` })
      .from(kempoCreditPurchase)
      .where(and(who, gte(kempoCreditPurchase.lastFailedAt, since)));
    return row?.total ?? 0;
  };

  const reason = await declines(eq(kempoCreditPurchase.userId, purchase.userId)) >= config.failedPaymentLimit
    ? 'user-declines'
    : purchase.ip && await declines(eq(kempoCreditPurchase.ip, purchase.ip)) >= config.failedPaymentLimit ? 'ip-declines' : null;

  if(!reason) return [null, { purchase: updated, blocked: false }];

  if(isAwaitingCustomer(payment.status)){
    const [cancelError] = await cancelPayment(payment.id);
    if(cancelError) console.warn(`[${OWNER}] Could not cancel payment ${payment.id} after too many declines: ${cancelError.msg}`);
  }

  const [, blocked] = await updatePurchase(purchase.id, { status: 'blocked', blockedReason: reason });
  await notifyAdmins({
    title: 'A credit purchase was stopped after repeated declines',
    message: `${REASONS[reason]}. The payment was cancelled at the processor so no more cards can be tried against it.`,
    dedupeKey: 'blocked-purchases',
    url: '/admin/extension/kempo-credits/?tab=purchases&status=blocked',
  });

  return [null, { purchase: blocked || updated, blocked: true }];
};

export const onPaymentCanceled = async ({ payment } = {}) => {
  if(!ours(payment)) return ignored;

  const [loadError, purchase] = await getPurchase({ purchaseId: payment.reference });
  if(loadError) return [loadError, null];
  if(purchase.status !== 'pending') return [null, { purchase }];

  return updatePurchase(purchase.id, { status: 'canceled' }).then(([error, updated]) => error ? [error, null] : [null, { purchase: updated }]);
};

/*
  A refund, whole or in part, wherever it was made — this site's admin or the processor's
  dashboard. The credits taken back are the refunded share of the pack, worked out from the
  payment's running refunded total rather than this one refund, so two refunds reported together, or
  one reported twice, still take back exactly the right number. Anything already spent becomes a
  shortfall; see clawback.js.
*/
export const onPaymentRefunded = async ({ payment, refund } = {}) => {
  if(!ours(payment)) return ignored;

  const [loadError, purchase] = await getPurchase({ purchaseId: payment.reference });
  if(loadError) return [loadError, null];

  const captured = payment.amountCaptured || payment.amount;
  const refunded = Math.min(payment.amountRefunded || 0, captured);
  const target = creditsForRefund(purchase.credits, refunded, captured);

  let clawed = null;
  if(purchase.lotId){
    const owed = target - await clawedSoFar(purchase.lotId);
    if(owed > 0){
      const [error, result] = await clawBackGrant({
        lotId: purchase.lotId,
        amount: owed,
        reason: 'refund',
        idempotencyKey: `refund:${payment.id}:${refunded}`,
      });
      if(error && error.code !== 409) return [error, null];
      clawed = error ? null : result;
    }
  }

  const [updateError, updated] = await updatePurchase(purchase.id, {
    status: refunded >= captured ? 'refunded' : 'partially_refunded',
    refundedAmount: refunded,
    creditsClawedBack: purchase.lotId ? await clawedSoFar(purchase.lotId) : 0,
    shortfall: purchase.shortfall + (clawed && !clawed.duplicate ? clawed.shortfall : 0),
    refundedAt: new Date(),
  });
  if(updateError) return [updateError, null];

  if(updated.taxTransactionId && refund?.id && refund.amount > 0){
    const tax = await taxModule();
    const [taxError] = tax
      ? await tax.reverseTransaction({ transactionId: updated.taxTransactionId, reference: `${OWNER}:${purchase.id}:refund:${refund.id}`, amount: refund.amount })
      : [{ msg: 'kempo-tax was disabled before the refund could be recorded' }];
    if(taxError && taxError.code !== 409){
      await updatePurchase(purchase.id, { taxError: `Refund not reversed in the tax ledger: ${taxError.msg}` });
      await notifyAdmins({
        title: 'A credit refund is missing from the tax ledger',
        message: `Refunding purchase ${purchase.id} could not be reversed in kempo-tax: ${taxError.msg}`,
        dedupeKey: `tax:${purchase.id}`,
        url: `/admin/extension/kempo-credits/?tab=purchases&purchase=${purchase.id}`,
      });
    }
  }

  return [null, { purchase: updated, clawedBack: clawed }];
};

/*
  A chargeback opened or closed. Nothing is clawed back automatically: a dispute is not a refund, the
  merchant may win it, and taking credits away from somebody who turns out to have been right is
  its own complaint. It is flagged and an administrator is told, and "Claw back" on the purchase is
  one click if they decide to.
*/
export const onPaymentDisputed = async ({ payment, disputed } = {}) => {
  if(!ours(payment)) return ignored;

  const [loadError, purchase] = await getPurchase({ purchaseId: payment.reference });
  if(loadError) return [loadError, null];

  const [error, updated] = await updatePurchase(purchase.id, { disputed: !!disputed });
  if(error) return [error, null];

  if(disputed){
    await notifyAdmins({
      title: 'A credit purchase is being disputed',
      message: `The buyer of purchase ${purchase.id} (${purchase.credits} credits) has opened a chargeback. Its credits have not been touched — claw them back from the purchase if you decide to.`,
      dedupeKey: `dispute:${purchase.id}`,
      url: `/admin/extension/kempo-credits/?tab=purchases&purchase=${purchase.id}`,
    });
  }

  return [null, { purchase: updated }];
};

/*
  Brings a purchase into line with its payment, for the times a webhook has not arrived or a hook
  failed after it did: asks the processor what happened (kempo-payments' `syncPayment`, which fires
  the same hooks a webhook would), then applies the payment's current state directly in case nothing
  changed for a hook to fire about.

  Safe to call as often as wanted — every step is idempotent — but it is a call to the processor,
  so the buyer-facing route throttles it.
*/
export const reconcilePurchase = async ({ purchaseId } = {}) => {
  const [loadError, purchase] = await getPurchase({ purchaseId });
  if(loadError) return [loadError, null];
  if(!purchase.paymentId) return [null, purchase];

  await updatePurchase(purchase.id, { checkedAt: new Date() });

  const [syncError] = await syncPayment(purchase.paymentId);
  if(syncError) console.warn(`[${OWNER}] Could not re-read payment ${purchase.paymentId}: ${syncError.msg}`);

  const [paymentError, payment] = await getPayment(purchase.paymentId);
  if(paymentError) return [paymentError, null];

  if(payment.status === 'succeeded'){
    const [error] = await onPaymentSucceeded({ payment });
    if(error) return [error, null];
    if(payment.amountRefunded > 0){
      const [refundError] = await onPaymentRefunded({ payment });
      if(refundError) return [refundError, null];
    }
  } else if(payment.status === 'canceled'){
    await onPaymentCanceled({ payment });
  }

  return getPurchase({ purchaseId });
};

/*
  The buyer's "has it gone through yet?". Their own purchase only — anybody else's is a 404, not a
  403, so an id cannot be probed — and it asks the processor at most once every few seconds however
  often the page polls, since each ask is an API call the site pays for in rate limit.
*/
export const checkPurchase = async ({ purchaseId, userId, minimumSeconds = 5 } = {}) => {
  const [loadError, purchase] = await getPurchase({ purchaseId });
  if(loadError) return [loadError, null];
  if(!userId || purchase.userId !== userId) return [{ code: 404, msg: 'No such purchase' }, null];
  if(purchase.status !== 'pending' || !purchase.paymentId) return [null, purchase];
  if(purchase.checkedAt && Date.now() - new Date(purchase.checkedAt).getTime() < minimumSeconds * 1000) return [null, purchase];

  return reconcilePurchase({ purchaseId });
};
