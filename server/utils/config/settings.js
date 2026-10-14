import { getSetting } from 'kempo/server/sdk.js';

/*
  Every setting, read and made safe to use in one place.

  Each is editable on the settings screen, and several decide whether somebody can buy — a limit
  that is not a number must not become "no limit" or "nobody may buy". So everything the rest of the
  extension sees has been through a normaliser here, with the declared default behind it.
*/

export const OWNER = 'kempo-credits';

/*
  The same values kempo-config.json declares, as the real types. A static test checks they agree.
*/
export const DEFAULTS = {
  refundPolicy: 'Credits have no cash value and cannot be exchanged for money or transferred to another account.',
  taxClass: 'digital',
  lowBalanceThreshold: 0,
  expiringSoonDays: 14,
  paidCreditsExpire: false,
  paidCreditsExpiryDays: 365,
  purchaseLimitPerUser: 10,
  purchaseLimitPerIp: 20,
  purchaseLimitGlobal: 500,
  failedPaymentLimit: 3,
  failedPaymentCooldownMinutes: 60,
  trustProxy: false,
};

export const SETTING_NAMES = {
  refundPolicy: 'refund_policy',
  taxClass: 'tax_class',
  lowBalanceThreshold: 'low_balance_threshold',
  expiringSoonDays: 'expiring_soon_days',
  paidCreditsExpire: 'paid_credits_expire',
  paidCreditsExpiryDays: 'paid_credits_expiry_days',
  purchaseLimitPerUser: 'purchase_limit_per_user',
  purchaseLimitPerIp: 'purchase_limit_per_ip',
  purchaseLimitGlobal: 'purchase_limit_global',
  failedPaymentLimit: 'failed_payment_limit',
  failedPaymentCooldownMinutes: 'failed_payment_cooldown_minutes',
  trustProxy: 'trust_proxy',
};

/*
  A count that must be a whole number, at least `min`. Anything else is the default: a limit typed
  as "ten" is a typo, and the default is the value the site was installed with.
*/
const count = (value, fallback, min = 0) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= min ? number : fallback;
};

const flag = (value, fallback) => {
  if(typeof value === 'boolean') return value;
  if(value === 'true') return true;
  if(value === 'false') return false;
  return fallback;
};

const text = (value, fallback) => typeof value === 'string' ? value : fallback;

export const NORMALISE = {
  refundPolicy: value => text(value, DEFAULTS.refundPolicy),
  taxClass: value => text(value, DEFAULTS.taxClass).trim() || DEFAULTS.taxClass,
  lowBalanceThreshold: value => count(value, DEFAULTS.lowBalanceThreshold),
  expiringSoonDays: value => count(value, DEFAULTS.expiringSoonDays),
  paidCreditsExpire: value => flag(value, DEFAULTS.paidCreditsExpire),
  paidCreditsExpiryDays: value => count(value, DEFAULTS.paidCreditsExpiryDays, 1),
  purchaseLimitPerUser: value => count(value, DEFAULTS.purchaseLimitPerUser, 1),
  purchaseLimitPerIp: value => count(value, DEFAULTS.purchaseLimitPerIp, 1),
  purchaseLimitGlobal: value => count(value, DEFAULTS.purchaseLimitGlobal, 1),
  failedPaymentLimit: value => count(value, DEFAULTS.failedPaymentLimit, 1),
  failedPaymentCooldownMinutes: value => count(value, DEFAULTS.failedPaymentCooldownMinutes, 1),
  trustProxy: value => flag(value, DEFAULTS.trustProxy),
};

export const readConfig = async () => {
  const keys = Object.keys(DEFAULTS);

  const values = await Promise.all(keys.map(async key => {
    const [error, value] = await getSetting(OWNER, SETTING_NAMES[key], DEFAULTS[key]);
    return NORMALISE[key](error ? DEFAULTS[key] : value);
  }));

  return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
};
