import { checkPurchase } from '../../../../../../server/utils/purchases/payments.js';
import { presentForBuyer } from '../../../../../../server/utils/purchases/store.js';
import { refuse, requireSession } from '../../../../../../server/http/gate.js';

/*
  "Has my purchase gone through?" — what the buy page polls after the card form says it worked.

  It does not take the browser's word for anything. It asks the processor (at most once every few
  seconds, however often it is polled) and grants only if the processor says the payment succeeded.
  That covers the case a webhook has not arrived yet, or never will because the endpoint is
  misconfigured, without ever trusting the page.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return refuse(response, sessionError);

  const [error, purchase] = await checkPurchase({ purchaseId: request.params?.id, userId: session.user.id });
  if(error) return refuse(response, error);

  response.json({ purchase: presentForBuyer(purchase) });
};
