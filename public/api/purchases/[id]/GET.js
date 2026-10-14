import { getUserById } from 'kempo/server/sdk.js';
import { getPayment } from 'kempo-payments/sdk';
import { getPurchase } from '../../../../server/utils/purchases/store.js';
import { getLot } from '../../../../server/utils/ledger/read.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  One purchase with everything behind it: the buyer, the payment as kempo-payments has it, and the
  lot it granted with that lot's history — so "they say they paid and got nothing" or "they refunded
  and kept the credits" is answered from one screen.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const [error, purchase] = await getPurchase({ purchaseId: request.params?.id });
  if(error) return refuse(response, error);

  const [, user] = await getUserById(purchase.userId);
  const [, payment] = purchase.paymentId ? await getPayment(purchase.paymentId) : [null, null];
  const [, lot] = purchase.lotId ? await getLot({ lotId: purchase.lotId }) : [null, null];

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
  });
};
