import { getUserById } from 'kempo/server/sdk.js';
import { getPayment } from 'kempo-payments/sdk';
import { getPurchase } from '../../../../server/utils/purchases/store.js';
import { getLot } from '../../../../server/utils/ledger/read.js';
import { refundableFor } from '../../../../server/utils/purchases/refund.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  One purchase with everything behind it: the buyer, the payment as kempo-payments has it, the lot
  it granted with that lot's history, and how much of it can be refunded — so "they say they paid
  and got nothing" and "can I have my money back" are both answered from one screen.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const [error, purchase] = await getPurchase({ purchaseId: request.params?.id });
  if(error) return refuse(response, error);

  const [, user] = await getUserById(purchase.userId);
  const [, payment] = purchase.paymentId ? await getPayment(purchase.paymentId) : [null, null];
  const [, lot] = purchase.lotId ? await getLot({ lotId: purchase.lotId }) : [null, null];
  const [, refundable] = await refundableFor({ purchaseId: purchase.id });

  response.json({
    purchase,
    user: user ? { id: user.id, name: user.name, email: user.email } : null,
    payment: payment ? {
      id: payment.id,
      status: payment.status,
      amount: payment.amount,
      amountCaptured: payment.amountCaptured,
      amountRefunded: payment.amountRefunded,
      currency: payment.currency,
      livemode: payment.livemode,
      disputed: payment.disputed,
      lastError: payment.lastError,
    } : null,
    lot: lot || null,
    refundable: refundable ? { credits: refundable.credits, amount: refundable.amount, held: refundable.held, claimable: refundable.claimable, spent: refundable.spent } : null,
  });
};
