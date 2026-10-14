import { previewClaim } from '../../../../server/utils/claims/store.js';
import { refuse, requireSession } from '../../../../server/http/gate.js';

/*
  What a claim link is worth and whether it still works, for the page somebody lands on from it —
  including when they are not signed in yet, so the page can say what they will get for signing in.
  When they are, it also says whether they have already redeemed it.
*/
export default async (request, response) => {
  const [, session] = await requireSession(request);

  const [error, preview] = await previewClaim({ token: request.query?.token, userId: session?.user?.id || null });
  if(error) return refuse(response, error);

  response.json({ claim: preview, signedIn: !!session });
};
