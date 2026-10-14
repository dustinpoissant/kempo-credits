import { getUserById } from 'kempo/server/sdk.js';
import { listEntries } from '../../../../../server/utils/ledger/read.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/*
  One user's ledger, newest first, with who did each thing and why. `actors` names the people behind
  the entries on this page, so the screen can say who rather than show an id.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const query = request.query || {};
  const [error, result] = await listEntries({
    userId: request.params?.userId,
    type: query.type ? String(query.type).split(',').map(type => type.trim()).filter(Boolean) : undefined,
    limit: query.limit,
    offset: query.offset,
  });
  if(error) return refuse(response, error);

  const people = {};
  const ids = new Set(result.entries.flatMap(entry => [entry.actorId, entry.counterpartyId]).filter(Boolean));
  for(const id of ids){
    const [, person] = await getUserById(id);
    people[id] = person ? { name: person.name, email: person.email } : null;
  }

  response.json({ ...result, actors: people, counterparties: people });
};
