import { listAccounts } from '../../../server/utils/ledger/read.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  Balances, for the admin screen. `?search=` finds users by name, email or id — including users
  with no credits at all — and `?owing=1` narrows to users who owe credits after a refund.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const query = request.query || {};
  const [error, result] = await listAccounts({
    search: query.search,
    owing: query.owing === '1' || query.owing === 'true',
    limit: query.limit,
    offset: query.offset,
  });
  if(error) return refuse(response, error);

  response.json(result);
};
