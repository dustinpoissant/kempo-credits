import { listPurchases, presentForBuyer } from '../../../../server/utils/purchases/store.js';
import { refuse, requireSession } from '../../../../server/http/gate.js';

/*
  The signed-in user's own purchases — their receipts. Attempts the abuse limits refused are not
  purchases from the buyer's point of view and are left out.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return refuse(response, sessionError);

  const [error, result] = await listPurchases({
    userId: session.user.id,
    status: ['pending', 'paid', 'partially_refunded', 'refunded', 'failed', 'canceled'],
    limit: request.query?.limit,
    offset: request.query?.offset,
  });
  if(error) return refuse(response, error);

  response.json({ ...result, purchases: result.purchases.map(presentForBuyer) });
};
