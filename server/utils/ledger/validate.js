/*
  What a caller hands the ledger, checked before anything is written.

  Every one of these refuses rather than coerces. A credit amount of 12.5 is a caller that has
  confused credits with money, and rounding it would grant something nobody meant; a reference of
  `[object Object]` is a caller that passed the wrong thing, and storing it would make the entry
  impossible to find again.

  Postgres cannot store a NUL byte in text, so one anywhere in what is about to be written is
  refused up front rather than surfacing as a failed insert halfway through an operation.
*/

/*
  A lot's kind is a label the granting code chooses — `general`, `achievement`, `ad-reward`,
  `purchase` — so the ledger can tell one source of credits from another without knowing what any of
  them mean. The only thing the site itself does with one is the `non_transferable_kinds` setting.
*/
export const DEFAULT_KIND = 'general';

const KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;

/*
  Large enough for any real grant and well inside a Postgres integer, so a sum of a few of them can
  never overflow a column and wrap a balance negative.
*/
export const MAX_AMOUNT = 1000000000;

const TEXT_MAX = 500;
const KEY_MAX = 200;

export const hasNulByte = (...values) => values.some(value =>
  JSON.stringify(value ?? null)?.includes('\\u0000'),
);

export const cleanUserId = userId => {
  if(typeof userId !== 'string' || !userId.trim()) return [{ code: 400, msg: 'A user id is required' }, null];
  if(userId.length > KEY_MAX || hasNulByte(userId)) return [{ code: 400, msg: 'That is not a user id' }, null];
  return [null, userId.trim()];
};

export const cleanAmount = (amount, label = 'Amount') => {
  if(!Number.isSafeInteger(amount) || amount <= 0){
    return [{ code: 400, msg: `${label} must be a whole number of credits, more than zero` }, null];
  }
  if(amount > MAX_AMOUNT) return [{ code: 400, msg: `${label} cannot be more than ${MAX_AMOUNT} credits at once` }, null];
  return [null, amount];
};

export const cleanKind = kind => {
  if(kind === undefined || kind === null || kind === '') return [null, DEFAULT_KIND];
  if(typeof kind !== 'string' || !KIND_PATTERN.test(kind)){
    return [{ code: 400, msg: 'A kind is a short lowercase label: letters, numbers, hyphens and underscores, up to 50 characters' }, null];
  }
  return [null, kind];
};

/*
  The key a caller retries under. It is theirs to choose, and choosing it well is the whole point:
  the id of the thing being paid for, the webhook's payment id, the request's own id — something
  that is the same on the second attempt and different for the next real one.
*/
export const cleanKey = key => {
  const value = typeof key === 'number' && Number.isSafeInteger(key) ? String(key) : key;
  if(typeof value !== 'string' || !value.trim()) return [{ code: 400, msg: 'An idempotency key is required — the same value on a retry, a new one for a new request' }, null];
  if(value.length > KEY_MAX) return [{ code: 400, msg: `An idempotency key is at most ${KEY_MAX} characters` }, null];
  if(hasNulByte(value)) return [{ code: 400, msg: 'An idempotency key cannot contain null characters' }, null];
  return [null, value.trim()];
};

export const cleanText = (value, label, { required = false, max = TEXT_MAX } = {}) => {
  if(value === undefined || value === null || (typeof value === 'string' && !value.trim())){
    return required ? [{ code: 400, msg: `${label} is required` }, null] : [null, null];
  }
  if(typeof value !== 'string') return [{ code: 400, msg: `${label} must be text` }, null];
  if(value.length > max) return [{ code: 400, msg: `${label} is at most ${max} characters` }, null];
  if(hasNulByte(value)) return [{ code: 400, msg: `${label} cannot contain null characters` }, null];
  return [null, value.trim()];
};

/*
  `{ owner, ref }`: who asked, and their own id for why. Either both or neither — an owner with no
  ref cannot be looked up, and a ref with no owner could be anybody's.
*/
export const cleanReference = (reference, { required = false } = {}) => {
  if(reference === undefined || reference === null){
    return required ? [{ code: 400, msg: 'A reference is required: { owner, ref } — who is spending and their id for what' }, null] : [null, null];
  }
  if(typeof reference !== 'object' || Array.isArray(reference)){
    return [{ code: 400, msg: 'A reference is an object: { owner, ref }' }, null];
  }

  const ref = typeof reference.ref === 'number' && Number.isSafeInteger(reference.ref) ? String(reference.ref) : reference.ref;
  const [ownerError, owner] = cleanText(reference.owner, 'A reference owner', { required: true, max: KEY_MAX });
  if(ownerError) return [ownerError, null];
  const [refError, cleanRef] = cleanText(ref, 'A reference ref', { required: true, max: KEY_MAX });
  if(refError) return [refError, null];

  return [null, { owner, ref: cleanRef }];
};

const DAY = 86400000;

/*
  An expiry is either a date or a number of days from now — never both, because a caller passing
  both has two answers and no way to say which it meant.
*/
export const cleanExpiry = ({ expiresAt, expiresInDays } = {}, now = new Date()) => {
  const hasDate = expiresAt !== undefined && expiresAt !== null && expiresAt !== '';
  const hasDays = expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== '';

  if(hasDate && hasDays) return [{ code: 400, msg: 'Give an expiry date or a number of days, not both' }, null];

  if(hasDays){
    if(!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 36500){
      return [{ code: 400, msg: 'Expiry in days must be a whole number from 1 to 36500' }, null];
    }
    return [null, new Date(now.getTime() + expiresInDays * DAY)];
  }

  if(hasDate){
    const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if(Number.isNaN(date.getTime())) return [{ code: 400, msg: 'That expiry is not a date' }, null];
    if(date.getTime() <= now.getTime()) return [{ code: 400, msg: 'An expiry has to be in the future' }, null];
    return [null, date];
  }

  return [null, null];
};
