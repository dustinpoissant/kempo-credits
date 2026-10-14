import { createClaim } from '../../../server/utils/claims/store.js';
import { gate, refuse, wholeNumber } from '../../../server/http/gate.js';

/*
  Makes a claim link. The token comes back once, in this response, and is never shown again — only
  its hash is kept.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:grant');
  if(gateError) return refuse(response, gateError);

  const body = request.body && typeof request.body === 'object' ? request.body : {};

  const [error, result] = await createClaim({
    name: body.name,
    amount: wholeNumber(body.amount),
    lotExpiresAt: body.lotExpiresAt || undefined,
    lotExpiresInDays: wholeNumber(body.lotExpiresInDays),
    expiresAt: body.expiresAt || undefined,
    expiresInDays: wholeNumber(body.expiresInDays),
    maxRedemptions: wholeNumber(body.maxRedemptions),
    createdBy: session.user.id,
  });
  if(error) return refuse(response, error);

  response.json(result);
};
