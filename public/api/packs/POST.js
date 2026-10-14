import { createPack } from '../../../server/utils/packs/store.js';
import { gate, refuse, wholeNumber } from '../../../server/http/gate.js';

export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:packs');
  if(gateError) return refuse(response, gateError);

  const body = request.body && typeof request.body === 'object' ? request.body : {};

  const [error, pack] = await createPack({
    name: body.name,
    description: body.description,
    credits: wholeNumber(body.credits),
    price: wholeNumber(body.price),
    currency: body.currency || undefined,
    enabled: body.enabled,
    sort: wholeNumber(body.sort),
  });
  if(error) return refuse(response, error);

  response.json({ pack });
};
