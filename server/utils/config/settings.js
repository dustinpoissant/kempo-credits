import { getSetting } from 'kempo/server/sdk.js';

/*
  Every setting, read and made safe to use in one place.

  Each is editable on the settings screen, so everything the rest of the extension sees has been
  through a normaliser here, with the declared default behind it. A value that is not usable falls
  back rather than breaking the ledger.
*/

export const OWNER = 'kempo-credits';

/*
  The same values kempo-config.json declares, as the real types. A static test checks they agree.
*/
export const DEFAULTS = {
  lowBalanceThreshold: 0,
  nonTransferableKinds: '',
};

export const SETTING_NAMES = {
  lowBalanceThreshold: 'low_balance_threshold',
  nonTransferableKinds: 'non_transferable_kinds',
};

/*
  A count that must be a whole number, at least `min`. Anything else is the default: a threshold
  typed as "ten" is a typo, and the default is the value the site was installed with.
*/
const count = (value, fallback, min = 0) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= min ? number : fallback;
};

/*
  A comma-separated list of kind labels, trimmed, lowercased and without blanks or duplicates.
*/
const labels = (value, fallback) => {
  if(typeof value !== 'string') return fallback;
  return [...new Set(value.split(',').map(label => label.trim().toLowerCase()).filter(Boolean))].join(',');
};

export const NORMALISE = {
  lowBalanceThreshold: value => count(value, DEFAULTS.lowBalanceThreshold),
  nonTransferableKinds: value => labels(value, DEFAULTS.nonTransferableKinds),
};

export const kindList = value => String(value || '').split(',').map(label => label.trim()).filter(Boolean);

export const readConfig = async () => {
  const keys = Object.keys(DEFAULTS);

  const values = await Promise.all(keys.map(async key => {
    const [error, value] = await getSetting(OWNER, SETTING_NAMES[key], DEFAULTS[key]);
    return NORMALISE[key](error ? DEFAULTS[key] : value);
  }));

  return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
};
