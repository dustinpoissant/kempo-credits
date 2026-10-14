import { getBalance } from '../../../../server/utils/ledger/read.js';
import { refuse, requireSession } from '../../../../server/http/gate.js';

/*
  The signed-in user's own balance. There is no way to ask for anybody else's here: the user comes
  from the session, not the request.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return refuse(response, sessionError);

  const [error, balance] = await getBalance({ userId: session.user.id });
  if(error) return refuse(response, error);

  response.json({ balance });
};
