import { redeemClaim } from '../../../../server/utils/claims/store.js';
import { refuse, requireSession } from '../../../../server/http/gate.js';

/*
  Redeems a claim link for the signed-in user. The token travels in the body rather than the URL so
  it is not written into access logs by the redemption itself.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return refuse(response, { code: 401, msg: 'Sign in to claim these credits' });

  const [error, result] = await redeemClaim({ token: request.body?.token, userId: session.user.id });
  if(error) return refuse(response, error);

  response.json(result);
};
