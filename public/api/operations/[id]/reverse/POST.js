import reverseSpend from '../../../../../server/utils/ledger/reverse.js';
import { getOperation } from '../../../../../server/utils/ledger/read.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/*
  An administrator undoing a spend from the ledger screen — the feature it paid for failed, say.
  The credits go back to the lots they came from. Found by operation id, which is what the screen
  has; the spend's own idempotency key is looked up from it.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:adjust');
  if(gateError) return refuse(response, gateError);

  const [loadError, operation] = await getOperation({ operationId: request.params?.id });
  if(loadError) return refuse(response, loadError);
  if(operation.type !== 'spend' || !operation.idempotencyKey) return refuse(response, { code: 400, msg: 'Only a spend can be reversed' });

  const note = typeof request.body?.note === 'string' ? request.body.note : null;

  const [error, result] = await reverseSpend({
    userId: operation.userId,
    idempotencyKey: operation.idempotencyKey,
    reason: 'adjustment',
    actorId: session.user.id,
    note,
  });
  if(error) return refuse(response, error);

  response.json(result);
};
