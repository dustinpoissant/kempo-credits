import { getUserByEmail, getUserById } from 'kempo/server/sdk.js';
import transferCredits from '../../../../server/utils/ledger/transfer.js';
import { gate, refuse, wholeNumber } from '../../../../server/http/gate.js';

/*
  The signed-in user sending some of their own credits to another user.

  Needs `credits:transfer`, which nobody holds until the site gives it to a group. The sender is
  always the session's user — there is no way to name another — and the recipient is named by
  `toUserId` or `toEmail` and must be a real user: unlike the SDK, which takes the caller's word for
  it, a person typing a name into a box needs a typo to be an error and not credits nobody can reach.

  `idempotencyKey` is the form's own id for this submission, so a double click or a retried request
  sends once. It is required: without it a double click is two gifts.

  The response says who received them by name and nothing more.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:transfer');
  if(gateError) return refuse(response, gateError);

  const body = request.body && typeof request.body === 'object' ? request.body : {};

  const [lookupError, recipient] = body.toUserId
    ? await getUserById(String(body.toUserId))
    : body.toEmail ? await getUserByEmail(String(body.toEmail).trim()) : [{ code: 400, msg: 'Say who to send them to' }, null];
  if(lookupError) return refuse(response, lookupError.code === 404 ? { code: 404, msg: 'There is no user with that address' } : lookupError);

  const [error, sent] = await transferCredits({
    fromUserId: session.user.id,
    toUserId: recipient.id,
    amount: wholeNumber(body.amount),
    reason: 'gift',
    idempotencyKey: body.idempotencyKey,
    actorId: session.user.id,
    note: typeof body.note === 'string' ? body.note : null,
  });
  if(error) return refuse(response, error);

  response.json({
    amount: sent.amount,
    duplicate: sent.duplicate,
    to: { name: recipient.name },
    balance: sent.fromBalance,
  });
};
