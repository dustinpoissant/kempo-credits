import db from 'kempo/server/db/index.js';
import { getPayment, refundPayment } from 'kempo-payments/sdk';
import { OWNER } from '../config/settings.js';
import { findLot, grantState } from '../ledger/clawback.js';
import { getBalance } from '../ledger/read.js';
import { cleanText } from '../ledger/validate.js';
import { getPurchase } from './store.js';

/*
  Refunding a purchase of credits.

  **Spent credits are never refunded as money** — the site owner's rule. A purchase can be refunded
  only as far as the user still holds credits to give back: the credits of that purchase not yet
  taken back, and no more than the user's balance. A refund takes those credits back from the
  purchase's own lot first and then from the user's other credits.

  So when something bought with credits never arrived — a glitch — an administrator puts the credits
  back first, by reversing that spend (they return to the purchase they came from) or simply by
  giving the user credits, and the purchase is refundable again.

  The money is worked out cumulatively, so several partial refunds never add up to more than the
  credits they took back are worth, and a refund of everything that is left is the whole payment.
  It is rounded down, in the site's favour, which is the other side of a refund's credits being
  rounded up (see creditsForRefund).
*/

const muldiv = (a, b, c) => Number((BigInt(a) * BigInt(b)) / BigInt(c));

/*
  `{ credits, amount, currency, held, claimable, spent }`: how many credits can be taken back now and
  how much money that is; how many the user holds; how many of the purchase are not yet back; and how
  many of those are spent, which is what stands between the purchase and a full refund.
*/
export const refundableFor = async ({ purchaseId } = {}) => {
  const [purchaseError, purchase] = await getPurchase({ purchaseId });
  if(purchaseError) return [purchaseError, null];

  const none = { credits: 0, amount: 0, currency: purchase.currency, held: 0, claimable: 0, spent: 0, purchase };
  if(!['paid', 'partially_refunded'].includes(purchase.status) || !purchase.paymentId || !purchase.lotId) return [null, none];

  const [paymentError, payment] = await getPayment(purchase.paymentId);
  if(paymentError) return [paymentError, null];
  const [lotError, lot] = await findLot({ lotId: purchase.lotId });
  if(lotError) return [lotError, null];
  const [balanceError, balance] = await getBalance({ userId: purchase.userId });
  if(balanceError) return [balanceError, null];

  let state;
  try {
    state = await grantState(db, lot);
  } catch {
    return [{ code: 500, msg: 'Could not work out what is refundable' }, null];
  }

  const captured = payment.amountCaptured || payment.amount;
  const refunded = Math.min(payment.amountRefunded || 0, captured);
  const held = Math.max(0, balance.total);
  const credits = Math.min(state.claimable, held);

  const allowed = credits ? muldiv(captured, state.clawed + credits, purchase.credits) : refunded;
  const amount = Math.max(0, Math.min(captured, allowed) - refunded);

  return [null, {
    credits: amount ? credits : 0,
    amount,
    currency: payment.currency,
    held,
    claimable: state.claimable,
    spent: Math.max(0, state.claimable - held),
    purchase,
  }];
};

const explain = refundable => refundable.claimable === 0
  ? 'Nothing of this purchase is left to refund'
  : `Its credits have been spent, and spent credits are not refunded. Give them back first — reverse the spend on the user’s ledger, or give them credits — then refund`;

/*
  Refunds a purchase through kempo-payments, up to what `refundableFor` allows — all of it when no
  amount is given. Taking the credits back is not done here: the processor's refund fires
  `payment:refunded`, and the hook does it, exactly as for a refund made anywhere else.
*/
export const refundPurchase = async ({ purchaseId, amount, reason, issuedBy = null } = {}) => {
  const [reasonError, cleanReason] = cleanText(reason, 'A reason', { required: true, max: 500 });
  if(reasonError) return [reasonError, null];

  const [error, refundable] = await refundableFor({ purchaseId });
  if(error) return [error, null];
  if(!refundable.amount) return [{ code: 409, msg: explain(refundable), ...refundableSummary(refundable) }, null];

  const requested = amount === undefined || amount === null ? refundable.amount : amount;
  if(!Number.isSafeInteger(requested) || requested <= 0){
    return [{ code: 400, msg: 'A refund amount is a whole number of the currency’s smallest unit — 250 for $2.50' }, null];
  }
  if(requested > refundable.amount){
    return [{ code: 409, msg: `Only ${refundable.amount} of this purchase can be refunded: the rest of its credits have been spent`, ...refundableSummary(refundable) }, null];
  }

  const [refundError] = await refundPayment(refundable.purchase.paymentId, { amount: requested, reason: cleanReason, issuedBy });
  if(refundError) return [refundError, null];

  return getPurchase({ purchaseId });
};

const refundableSummary = ({ credits, amount, held, claimable, spent }) => ({ refundable: { credits, amount, held, claimable, spent } });

/*
  The same rule, applied to a refund started anywhere else on the site — kempo-payments' own screen
  and API fire `payment:refunding` first (from 0.1.10) and refuse the refund when a handler throws.
  A refund made in the processor's own dashboard cannot be stopped from here; that is the case the
  shortfall exists for.
*/
export const checkRefund = async ({ payment, amount } = {}) => {
  if(payment?.owner !== OWNER || typeof payment.reference !== 'string') return [null, { allowed: true }];

  const [error, refundable] = await refundableFor({ purchaseId: payment.reference });
  if(error) return [error, null];

  const requested = Number.isSafeInteger(amount) ? amount : (payment.amountCaptured || payment.amount) - (payment.amountRefunded || 0);
  if(requested > refundable.amount){
    return [{
      code: 409,
      msg: refundable.amount
        ? `Only ${refundable.amount} of this payment can be refunded: it bought credits that have since been spent. Refund it from Credits → Purchases, which shows what is refundable`
        : `${explain(refundable)}. This payment bought credits — refund it from Credits → Purchases`,
    }, null];
  }
  return [null, { allowed: true }];
};
