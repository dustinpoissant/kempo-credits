import { creditTotals } from '../../../server/utils/ledger/read.js';
import { purchaseSummary } from '../../../server/utils/purchases/store.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  The figures across the top of the admin screen and on the dashboard widget: credits held, what
  has sold in the last 30 days, and how many things need a person.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const [totalsError, totals] = await creditTotals();
  if(totalsError) return refuse(response, totalsError);

  const [salesError, sales] = await purchaseSummary({ days: 30 });
  if(salesError) return refuse(response, salesError);

  response.json({ credits: totals, purchases: sales });
};
