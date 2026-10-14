import { removeCredits } from '../../../../../server/utils/ledger/adjust.js';
import { gate, refuse, wholeNumber } from '../../../../../server/http/gate.js';

/*
  An administrator taking credits away — a grant made by mistake, say. Never more than the user has.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:adjust');
  if(gateError) return refuse(response, gateError);

  const body = request.body && typeof request.body === 'object' ? request.body : {};

  const [error, result] = await removeCredits({
    userId: request.params?.userId,
    amount: wholeNumber(body.amount),
    note: body.note,
    idempotencyKey: body.idempotencyKey,
    actorId: session.user.id,
  });
  if(error) return refuse(response, error);

  response.json(result);
};
