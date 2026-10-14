import startPurchase from '../../../../server/utils/purchases/start.js';
import { readConfig } from '../../../../server/utils/config/settings.js';
import { clientIp, gate, refuse, userAgent } from '../../../../server/http/gate.js';

/*
  Starts buying a pack for the signed-in user.

  The body names a pack and, when tax applies, a billing address — never an amount. What is charged
  is the pack's price and the tax on it, worked out on this server. Needs `credits:purchase`, which
  every signed-in user holds unless the site has taken it away; nobody signed out can buy at all.

  The response carries the client secret for kempo-payments' `<k-pay-form>`, and `shown`: the
  figures and refund policy the page must show before the buyer pays, which are also what this
  purchase records as having been shown.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'credits:purchase');
  if(gateError) return refuse(response, gateError);

  const config = await readConfig();
  const body = request.body && typeof request.body === 'object' ? request.body : {};

  const [error, result] = await startPurchase({
    userId: session.user.id,
    packId: body.packId,
    address: body.address && typeof body.address === 'object' ? body.address : null,
    ip: clientIp(request, config.trustProxy),
    userAgent: userAgent(request),
    email: session.user.email || null,
  });
  if(error) return refuse(response, error);

  response.json(result);
};
