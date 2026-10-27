import { hasNulByte } from '../ledger/validate.js';
import { SETTING_NAMES } from './settings.js';

/*
  What the settings screen may save, checked strictly. The normalisers in settings.js are forgiving
  on purpose — a bad stored value falls back to the default rather than breaking the ledger — but a
  value somebody is typing in right now gets told what is wrong with it instead.
*/

const KEYS = Object.fromEntries(Object.entries(SETTING_NAMES).map(([key, name]) => [name, key]));

const number = (label, min, max) => value => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? [null, parsed]
    : [{ code: 400, msg: `${label} must be a whole number from ${min} to ${max}` }, null];
};

const KIND = /^[a-z0-9][a-z0-9_-]{0,49}$/;

const kinds = label => value => {
  if(typeof value !== 'string') return [{ code: 400, msg: `${label} must be text` }, null];
  if(hasNulByte(value)) return [{ code: 400, msg: `${label} cannot contain null characters` }, null];
  const list = [...new Set(value.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean))];
  const bad = list.find(entry => !KIND.test(entry));
  if(bad) return [{ code: 400, msg: `"${bad}" is not a kind: use lowercase letters, numbers, hyphens and underscores` }, null];
  return [null, list.join(',')];
};

export const VALIDATORS = {
  credits_per_unit: number('Credits per unit', 1, 1000000),
  low_balance_threshold: number('The low-balance threshold', 0, 1000000000),
  non_transferable_kinds: kinds('Non-transferable kinds'),
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
