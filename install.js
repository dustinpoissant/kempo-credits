import { createIndexes } from './server/db/indexes.js';

/*
  What kempo-config.json cannot say: the indexes. kempo's installer makes this extension's tables
  from the Drizzle schema with their columns and primary keys and nothing else — indexes declared in
  the schema are not carried across, and one of them is what makes a retried request grant once. See
  server/db/indexes.js. If it cannot be made the install fails rather than going ahead without it.

  Nobody holds `credits:transfer` after installing. Sending credits between users is something a
  site turns on by giving that permission to a group, deliberately.
*/
export default async () => {
  await createIndexes();
  console.log('[kempo-credits] Installed. Other extensions grant credits through kempo-credits/sdk; to sell them, install kempo-credit-packs.');
};
