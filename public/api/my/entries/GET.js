import { listEntries } from '../../../../server/utils/ledger/read.js';
import { refuse, requireSession } from '../../../../server/http/gate.js';

/*
  The signed-in user's own ledger, newest first: every grant, spend, refund and expiry that made
  their balance what it is.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return refuse(response, sessionError);

  const [error, result] = await listEntries({
    userId: session.user.id,
    limit: request.query?.limit,
    offset: request.query?.offset,
  });
  if(error) return refuse(response, error);

  /*
    Who did something, and their notes, are an administrator's record. The user sees what happened
    to their credits and why, in the words the operation was given.
  */
  response.json({
    ...result,
    entries: result.entries.map(({ actorId, note, idempotencyKey, ...entry }) => entry),
  });
};
