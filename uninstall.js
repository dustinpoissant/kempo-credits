import { gt, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoCreditLot } from './server/db/schema.js';

/*
  Nothing here is deleted. Uninstalling without purging leaves every table in place, so reinstalling
  restores every balance exactly; purging drops them, and that is kempo's decision to make, not this
  script's.

  What this does is say what is at stake, because there is no undo. Credits that users **paid for**
  are a prepaid balance the site still owes them — removing the extension does not make that
  obligation go away, it only removes the record of it. So the count is printed, loudly, before a
  purge can take it.
*/
export default async () => {
  try {
    const [row] = await db.select({
      users: sql`count(distinct ${kempoCreditLot.userId})::int`,
      paid: sql`coalesce(sum(${kempoCreditLot.remaining}) filter (where ${kempoCreditLot.kind} = 'paid'), 0)::bigint`,
      promo: sql`coalesce(sum(${kempoCreditLot.remaining}) filter (where ${kempoCreditLot.kind} = 'promo'), 0)::bigint`,
    }).from(kempoCreditLot).where(gt(kempoCreditLot.remaining, 0));

    const paid = Number(row?.paid || 0);
    console.log(`[kempo-credits] Removing. ${row?.users || 0} user${row?.users === 1 ? '' : 's'} hold credits: ${paid} paid and ${Number(row?.promo || 0)} promo.`);
    if(paid){
      console.warn(`[kempo-credits] ${paid} of those credits were bought. Purging the data deletes the only record of a balance your users paid for — export it first.`);
    }
  } catch {
    // The tables may already be gone; there is nothing to report on.
  }
};
