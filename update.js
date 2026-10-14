import { createIndexes } from './server/db/indexes.js';

/*
  Updating makes sure the indexes exist — every statement is `IF NOT EXISTS`, so this is safe from
  any version to any other — and nothing else. In particular it does not give `credits:purchase` to
  `system:Users` again: a site that took it away meant to.

  New settings, permissions and groups are added by kempo's own declarative diff, and existing values
  are never overwritten, so a site's limits, refund policy and expiry choices survive an update.
*/
export default async () => {
  await createIndexes();
};
