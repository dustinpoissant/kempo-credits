import { listPacks } from '../../../server/utils/packs/store.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  The packs on sale. Public: prices are something a visitor should see before deciding to sign up.

  `?all=1` lists disabled packs too, for the admin screen, and needs `credits:packs`.
*/
export default async (request, response) => {
  const all = request.query?.all === '1' || request.query?.all === 'true';

  if(all){
    const [gateError] = await gate(request, 'credits:packs');
    if(gateError) return refuse(response, gateError);
  }

  const [error, packs] = await listPacks({ enabledOnly: !all });
  if(error) return refuse(response, error);

  response.json({
    packs: all ? packs : packs.map(({ id, name, description, credits, price, currency }) => ({ id, name, description, credits, price, currency })),
  });
};
