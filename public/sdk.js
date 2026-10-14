/*
  Browser client, served at /credits/sdk.js.

  Every call returns an `[error, data]` tuple like the rest of kempo. An error carries the extra
  fields a route sent with it — `balance` and `needed` on a 402 — so a page can say something more
  useful than "no".

  There is no `spend` here, on purpose: spending is the server-side code of whatever feature is
  being paid for, which is the only thing that knows what was bought.
*/

const BASE = '/credits/api';

const request = async (path, options = {}) => {
  try {
    const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if(!response.ok){
      const { error, ...details } = data;
      return [{ code: response.status, msg: error || response.statusText, ...details }, null];
    }
    return [null, data];
  } catch(error) {
    return [{ code: 0, msg: error.message }, null];
  }
};

const send = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

const query = params => {
  const search = new URLSearchParams();
  for(const [key, value] of Object.entries(params || {})){
    if(value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

/*
  An id for one submission of a form, sent as its idempotency key so a double click or a retried
  request is applied once. Make a new one per submission, and reuse it only to retry that same one.
*/
export const newKey = () => crypto.randomUUID();

/*
  Your own
*/

export const getMyBalance = () => request('/my/balance');

export const listMyEntries = (params = {}) => request(`/my/entries${query(params)}`);

/*
  Send some of your credits to another user, named by `toUserId` or `toEmail`. Needs the
  `credits:transfer` permission, which the site has to have given you.
*/
export const sendCredits = ({ toUserId, toEmail, amount, note, idempotencyKey } = {}) => request('/my/transfers', send('POST', { toUserId, toEmail, amount, note, idempotencyKey }));

/*
  Administration — each needs its own credits:* permission
*/

export const getSummary = () => request('/summary');

export const listAccounts = (params = {}) => request(`/accounts${query(params)}`);

export const getAccount = userId => request(`/accounts/${encodeURIComponent(userId)}`);

export const listAccountEntries = (userId, params = {}) => request(`/accounts/${encodeURIComponent(userId)}/entries${query(params)}`);

export const grantCredits = (userId, body) => request(`/accounts/${encodeURIComponent(userId)}/grant`, send('POST', body));

export const removeCredits = (userId, body) => request(`/accounts/${encodeURIComponent(userId)}/remove`, send('POST', body));

export const forgiveDebt = (userId, body) => request(`/accounts/${encodeURIComponent(userId)}/forgive`, send('POST', body));

export const clawBackLot = (lotId, body) => request(`/lots/${encodeURIComponent(lotId)}/claw-back`, send('POST', body));

export const reverseOperation = (operationId, body) => request(`/operations/${encodeURIComponent(operationId)}/reverse`, send('POST', body));

export const getSettings = () => request('/settings');

export const saveSettings = body => request('/settings', send('PUT', body));
