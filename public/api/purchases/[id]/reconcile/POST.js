import { reconcilePurchase } from '../../../../../server/utils/purchases/payments.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/*
  Re-reads a purchase's payment from the processor and applies whatever it says — the button for a
  purchase that looks stuck. Idempotent: a purchase already granted is not granted again.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const [error, purchase] = await reconcilePurchase({ purchaseId: request.params?.id });
  if(error) return refuse(response, error);

  response.json({ purchase });
};
