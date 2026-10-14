import { getUserById } from 'kempo/server/sdk.js';
import { auditAccount, listLots } from '../../../../server/utils/ledger/read.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  One user's credits: who they are, their balance, every lot they have ever been granted, and the
  audit that proves the balance from the ledger. The entries are paged separately (./entries).

  A user id with no kempo user behind it is still answered — a deleted account can have a ledger,
  and that ledger is exactly what somebody may need to look at.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:view');
  if(gateError) return refuse(response, gateError);

  const userId = request.params?.userId;
  const [, user] = await getUserById(userId);

  const [lotsError, lots] = await listLots({ userId });
  if(lotsError) return refuse(response, lotsError);

  const [auditError, audit] = await auditAccount({ userId });
  if(auditError) return refuse(response, auditError);

  response.json({
    user: user ? { id: user.id, name: user.name, email: user.email } : { id: userId, name: null, email: null },
    balance: audit.balance,
    lots,
    audit: { ok: audit.ok, lots: audit.lots, entries: audit.entries, problems: audit.problems },
  });
};
