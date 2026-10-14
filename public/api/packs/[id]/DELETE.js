import { deletePack } from '../../../../server/utils/packs/store.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  Deletes a pack nobody has bought. One that has been bought can only be disabled.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:packs');
  if(gateError) return refuse(response, gateError);

  const [error, result] = await deletePack({ packId: request.params?.id });
  if(error) return refuse(response, error);

  response.json(result);
};
