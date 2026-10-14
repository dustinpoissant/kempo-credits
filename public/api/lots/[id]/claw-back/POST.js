import clawBackGrant from '../../../../../server/utils/ledger/clawback.js';
import { gate, refuse, wholeNumber } from '../../../../../server/http/gate.js';

/*
  An administrator taking a grant back — after a dispute, or a refund made outside the processor.
  What was already spent becomes what the user owes; see clawback.js.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:adjust');
  if(gateError) return refuse(response, gateError);

  const body = request.body && typeof request.body === 'object' ? request.body : {};
  if(typeof body.note !== 'string' || !body.note.trim()) return refuse(response, { code: 400, msg: 'Say why — the note is what explains this later' });

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
