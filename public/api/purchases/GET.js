import { listPurchases } from '../../../server/utils/purchases/store.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  Every purchase, for the admin screen. `?status=blocked` is the blocked-attempt log; statuses can
  be comma-separated. `?userId=` narrows to one buyer.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const query = request.query || {};
  const status = query.status ? String(query.status).split(',').map(value => value.trim()).filter(Boolean) : undefined;

  const [error, result] = await listPurchases({
    status: status?.length === 1 ? status[0] : status,
    userId: query.userId || undefined,
    limit: query.limit,
    offset: query.offset,
  });
  if(error) return refuse(response, error);

  response.json(result);
};
