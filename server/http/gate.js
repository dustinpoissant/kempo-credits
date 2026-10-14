import { getSession, currentUserHasPermission } from 'kempo/server/sdk.js';

/*
  The HTTP layer's own helpers — who is asking, and are they allowed. They live here rather than in
  server/utils because they read requests, and nothing under server/utils does.

  Routes come in three kinds, and each says which it is by what it calls:

  - **Your own.** Everything under /credits/api/my/ is about the signed-in user and nobody else, so
    it needs a session and no permission — the user id comes from the session, never the request.
  - **Administrative.** Every other route that reads or changes somebody's credits
    needs its own `credits:*` permission.
  - **Public.** The packs on sale, what the checkout needs to render, and a claim link's preview.
*/

export const requireSession = async request => {
  const token = request.cookies?.session_token;
  if(!token) return [{ code: 401, msg: 'Sign in first' }, null];

  const [error, session] = await getSession({ token });
  if(error || !session?.user) return [{ code: 401, msg: 'Sign in first' }, null];

  return [null, { token, user: session.user }];
};

export const gate = async (request, permission) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return [sessionError, null];

  const [error, allowed] = await currentUserHasPermission(session.token, permission);
  if(error) return [{ code: error.code, msg: error.msg }, null];
  if(!allowed) return [{ code: 403, msg: 'You do not have permission to do that' }, null];

  return [null, session];
};

/*
  Sends an error tuple's error. The extra fields a 402 or 429 carries — how short the balance is,
  when to try again — go to the caller too, since they are what a page needs to say something useful.
*/
export const refuse = (response, { code, msg, ...details }) => {
  if(details.retryAfter) response.set('Retry-After', String(details.retryAfter));
  return response.status(code || 500).json({ error: msg, ...details });
};

/*
  A whole number from a JSON body or a query string, or undefined when there is none. Anything that
  is not one is passed through as-is, so the utility it reaches refuses it with its own message.
*/
export const wholeNumber = value => {
  if(value === undefined || value === null || value === '') return undefined;
  if(typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return value;
};
