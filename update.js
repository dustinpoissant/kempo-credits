import { deleteSetting } from 'kempo/server/sdk.js';
import { createIndexes } from './server/db/indexes.js';

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

export default async () => {
  await createIndexes();
  for(const name of RETIRED) await deleteSetting('kempo-credits', name);
};
