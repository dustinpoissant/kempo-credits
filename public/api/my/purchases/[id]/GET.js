import { getPurchase, presentForBuyer } from '../../../../../server/utils/purchases/store.js';
import { refuse, requireSession } from '../../../../../server/http/gate.js';

/*
  One of the signed-in user's own purchases. Anybody else's is a 404, the same as one that does not
  exist, so purchase ids cannot be probed.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return refuse(response, sessionError);

  const [error, purchase] = await getPurchase({ purchaseId: request.params?.id });
  if(error || purchase.userId !== session.user.id || purchase.status === 'blocked') {
    return refuse(response, error?.code === 500 ? error : { code: 404, msg: 'No such purchase' });
  }

  response.json({ purchase: presentForBuyer(purchase) });
};
