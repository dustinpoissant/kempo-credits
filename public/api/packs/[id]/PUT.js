import { updatePack } from '../../../../server/utils/packs/store.js';
import { gate, refuse, wholeNumber } from '../../../../server/http/gate.js';

/*
  Edits a pack. A purchase already made keeps the price and credits it was sold at.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:packs');
  if(gateError) return refuse(response, gateError);

  const body = request.body && typeof request.body === 'object' ? request.body : {};

  const [error, pack] = await updatePack({
    packId: request.params?.id,
    name: body.name,
    description: body.description,
    credits: wholeNumber(body.credits),
    price: wholeNumber(body.price),
    currency: body.currency,
    enabled: body.enabled,
    sort: wholeNumber(body.sort),
  });
  if(error) return refuse(response, error);

  response.json({ pack });
};
