import { hasNulByte } from '../ledger/validate.js';
import { SETTING_NAMES } from './settings.js';

/*
  What the settings screen may save, checked strictly. The normalisers in settings.js are forgiving
  on purpose — a bad stored value falls back to the default rather than breaking the shop — but a
  value somebody is typing in right now gets told what is wrong with it instead.
*/

const KEYS = Object.fromEntries(Object.entries(SETTING_NAMES).map(([key, name]) => [name, key]));

const number = (label, min, max) => value => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? [null, parsed]
    : [{ code: 400, msg: `${label} must be a whole number from ${min} to ${max}` }, null];
};

const flag = label => value => {
  if(value === true || value === 'true') return [null, true];
  if(value === false || value === 'false') return [null, false];
  return [{ code: 400, msg: `${label} is on or off` }, null];
};

const text = (label, max, { required = false } = {}) => value => {
  if(typeof value !== 'string') return [{ code: 400, msg: `${label} must be text` }, null];
  if(required && !value.trim()) return [{ code: 400, msg: `${label} cannot be empty` }, null];
  if(value.length > max) return [{ code: 400, msg: `${label} is at most ${max} characters` }, null];
  if(hasNulByte(value)) return [{ code: 400, msg: `${label} cannot contain null characters` }, null];
  return [null, value.trim()];
};

export const VALIDATORS = {
  refund_policy: text('The refund policy', 2000),
  tax_class: text('The tax class', 100, { required: true }),
  low_balance_threshold: number('The low-balance threshold', 0, 1000000000),
  purchase_limit_per_user: number('The per-account limit', 1, 100000),
  purchase_limit_per_ip: number('The per-address limit', 1, 100000),
  purchase_limit_global: number('The site-wide limit', 1, 10000000),
  failed_payment_limit: number('The decline limit', 1, 1000),
  failed_payment_cooldown_minutes: number('The cool-down', 1, 10080),
  trust_proxy: flag('Trusting the proxy'),
};

/*
  `[error, updates]` — the settings in `body` that are known, each validated. Unknown names are an
  error rather than ignored: a typo in a setting name should not look like a save that worked.
*/
export const validateSettings = body => {
  if(!body || typeof body !== 'object' || Array.isArray(body)) return [{ code: 400, msg: 'Send the settings as an object' }, null];

  const updates = {};
  for(const [name, value] of Object.entries(body)){
    if(!KEYS[name] || !VALIDATORS[name]) return [{ code: 400, msg: `"${name}" is not a credits setting` }, null];
    const [error, clean] = VALIDATORS[name](value);
    if(error) return [error, null];
    updates[name] = clean;
  }

  if(!Object.keys(updates).length) return [{ code: 400, msg: 'Nothing to save' }, null];
  return [null, updates];
};
