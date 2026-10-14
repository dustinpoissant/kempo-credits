import { setClaimEnabled } from '../../../../server/utils/claims/store.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  Turns a claim link off, or back on. Nothing else about a link changes once it has been shared.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:grant');
  if(gateError) return refuse(response, gateError);

  const [error, claim] = await setClaimEnabled({ claimId: request.params?.id, enabled: request.body?.enabled });
  if(error) return refuse(response, error);

  response.json({ claim });
};
