import grantCredits from '../../../../../server/utils/ledger/grant.js';
import { gate, refuse, wholeNumber } from '../../../../../server/http/gate.js';

/*
  An administrator giving a user promo credits — a goodwill gesture, a prize, a correction in their
  favour. Always promo: bought credits only ever come from a purchase. The note is required and is
  what the ledger shows next to the grant forever after; who granted it is the signed-in user, never
  anything in the body.

  `idempotencyKey` is the form's own id for this submission, so a double click or a retried request
  grants once.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:grant');
  if(gateError) return refuse(response, gateError);

  const body = request.body && typeof request.body === 'object' ? request.body : {};
  if(typeof body.note !== 'string' || !body.note.trim()) return refuse(response, { code: 400, msg: 'Say why — the note is what explains this grant later' });

  const [error, result] = await grantCredits({
    userId: request.params?.userId,
    amount: wholeNumber(body.amount),
    kind: 'promo',
    expiresAt: body.expiresAt || undefined,
    expiresInDays: wholeNumber(body.expiresInDays),
    reason: 'promo',
    idempotencyKey: body.idempotencyKey,
    actorId: session.user.id,
    note: body.note,
  });
  if(error) return refuse(response, error);

  response.json(result);
};
