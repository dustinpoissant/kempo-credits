import { clawBackGrant } from '../../../../../server/utils/ledger/clawback.js';
import { gate, refuse, wholeNumber } from '../../../../../server/http/gate.js';

/*
  An administrator taking a grant back without refunding any money — after a chargeback the site
  lost, say. Credits come from the grant's own lot, then the user's other credits; what neither
  covers is owed. See clawback.js.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:adjust');
  if(gateError) return refuse(response, gateError);

  const body = request.body && typeof request.body === 'object' ? request.body : {};

  const [error, result] = await clawBackGrant({
    lotId: request.params?.id,
    amount: wholeNumber(body.amount),
    reason: 'adjustment',
    idempotencyKey: body.idempotencyKey,
    actorId: session.user.id,
    note: body.note,
  });
  if(error) return refuse(response, error);

  response.json(result);
};
