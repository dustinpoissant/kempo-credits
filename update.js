import { deleteSetting } from 'kempo/server/sdk.js';
import { createIndexes } from './server/db/indexes.js';

/*
  Updating makes sure the indexes exist — every statement is `IF NOT EXISTS`, so this is safe from
  any version to any other — and retires settings that no longer mean anything. It does not give
  `credits:purchase` to `system:Users` again: a site that took it away meant to.

  New settings, permissions and groups are added by kempo's own declarative diff, and existing values
  are never overwritten. That diff never removes one, though, so the expiry settings — from before
  credits were made never-expiring — are deleted here rather than left on /admin/settings promising
  something that cannot happen.
*/
const RETIRED = ['expiring_soon_days', 'paid_credits_expire', 'paid_credits_expiry_days'];

export default async () => {
  await createIndexes();
  for(const name of RETIRED) await deleteSetting('kempo-credits', name);
};
