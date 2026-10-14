import { currentUserHasPermission } from 'kempo/server/sdk.js';
import { refundPurchase } from '../../../../../server/utils/purchases/refund.js';
import { gate, refuse, wholeNumber } from '../../../../../server/http/gate.js';

/*
  Refunds a purchase of credits, up to what the buyer still holds — all of that when no amount is
  given. It moves money, so it needs kempo-payments' `payments:refund` as well as `credits:adjust`.
  Who refunded is the signed-in user, never anything in the body.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:adjust');
  if(gateError) return refuse(response, gateError);

  const [permissionError, mayRefund] = await currentUserHasPermission(session.token, 'payments:refund');
  if(permissionError) return refuse(response, permissionError);
  if(!mayRefund) return refuse(response, { code: 403, msg: 'Refunding money needs the payments:refund permission as well' });

  const body = request.body && typeof request.body === 'object' ? request.body : {};

  const [error, purchase] = await refundPurchase({
    purchaseId: request.params?.id,
    amount: wholeNumber(body.amount),
    reason: body.reason,
    issuedBy: session.user.id,
  });
  if(error) return refuse(response, error);

  response.json({ purchase });
};
