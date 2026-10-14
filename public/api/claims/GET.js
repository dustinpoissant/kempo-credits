import { listClaims } from '../../../server/utils/claims/store.js';
import { gate, refuse } from '../../../server/http/gate.js';

export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:grant');
  if(gateError) return refuse(response, gateError);

  const [error, result] = await listClaims({ limit: request.query?.limit, offset: request.query?.offset });
  if(error) return refuse(response, error);

  response.json(result);
};
