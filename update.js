import { registerCreditsProductType } from './install.js';
import { deleteSetting, getSetting, setSetting } from 'kempo/server/sdk.js';
import { createIndexes, ensureColumns } from './server/db/indexes.js';
import { descriptionOf, typeOf } from './server/utils/config/declared.js';

/*
  Updating makes sure the indexes exist — every statement is `IF NOT EXISTS`, so this is safe from
  any version to any other — and retires settings that no longer belong here.

  kempo's declarative diff adds new settings, permissions and groups and never overwrites a value,
  but it never removes one either. Selling credits and claim links moved out to kempo-credit-packs
  and kempo-credit-claims, and credits were made never-expiring, so the settings those used are
  deleted here rather than left on /admin/settings promising something this extension no longer does.
*/
const RETIRED = [
  'expiring_soon_days', 'paid_credits_expire', 'paid_credits_expiry_days',
  'refund_policy', 'tax_class', 'trust_proxy',
  'purchase_limit_per_user', 'purchase_limit_per_ip', 'purchase_limit_global',
  'failed_payment_limit', 'failed_payment_cooldown_minutes',
];

/*
  The rate used to be kempo-products' setting. It moves here once: a value kempo-products still holds
  is copied across, then removed from it, so later updates never overwrite what the site set here.
*/
const takeLegacyRate = async () => {
  const [, legacy] = await getSetting('kempo-products', 'credits_per_unit', null);
  if(legacy === null) return;
  await setSetting('kempo-credits', 'credits_per_unit', Number(legacy), typeOf('credits_per_unit'), false, descriptionOf('credits_per_unit'));
  await deleteSetting('kempo-products', 'credits_per_unit');
};

export default async () => {
  await ensureColumns();
  await createIndexes();
  await registerCreditsProductType();
  for(const name of RETIRED) await deleteSetting('kempo-credits', name);
  await takeLegacyRate();
};
