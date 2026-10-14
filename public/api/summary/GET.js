import { creditTotals } from '../../../server/utils/ledger/read.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  The figures across the top of the admin screen and on the dashboard widget: credits held, and who
  owes credits after a refund.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const [error, credits] = await creditTotals();
  if(error) return refuse(response, error);

  response.json({ credits });
};
