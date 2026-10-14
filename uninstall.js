import { gt, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoCreditLot } from './server/db/schema.js';

/*
  Nothing here is deleted. Uninstalling without purging leaves every table in place, so reinstalling
  restores every balance exactly; purging drops them, and that is kempo's decision to make, not this
  script's.

  What this does is say what is at stake, because there is no undo. Credits are a balance users hold
  — and anything that sold them, or promised them as a reward, owes them still. Removing this
  extension does not make that obligation go away, it only removes the record of it. So the count is
  printed, loudly, before a purge can take it.
*/
export default async () => {
  try {
    const [row] = await db.select({
      users: sql`count(distinct ${kempoCreditLot.userId})::int`,
      credits: sql`coalesce(sum(${kempoCreditLot.remaining}), 0)::bigint`,
    }).from(kempoCreditLot).where(gt(kempoCreditLot.remaining, 0));

    const credits = Number(row?.credits || 0);
    console.log(`[kempo-credits] Removing. ${row?.users || 0} user${row?.users === 1 ? '' : 's'} hold ${credits} credits.`);
    if(credits){
      console.warn('[kempo-credits] Purging the data deletes the only record of those balances — export them first if anything promised them to users.');
    }
  } catch {
    // The tables may already be gone; there is nothing to report on.
  }
};
