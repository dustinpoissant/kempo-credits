import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  How every change to a balance is made safe to run twice at once.

  Each operation runs inside one transaction that first takes a lock for each user it touches. The
  lock is a Postgres advisory lock keyed on the user id, held until the transaction ends, so two
  operations on the same user queue behind each other and the second one reads what the first one
  wrote. Two simultaneous spends of the last 100 credits therefore cannot both see 100: the second
  sees 0 and fails. Operations on different users never wait for each other.

  An advisory lock rather than `SELECT … FOR UPDATE` on the lots, because there is not always a lot
  to lock — the first grant to a user, or an idempotent retry of one, has no row to hang a lock on
  until it has already decided what to do. The lot updates are conditional as well
  (`remaining + amount >= 0`), and the idempotency key is a unique index, so neither guarantee rests
  on the lock alone.

  Locks are taken in sorted order, so two operations that each touch the same two users cannot
  deadlock by taking them the other way round.
*/

class Abort {
  constructor(result){
    this.result = result;
  }
}

/*
  Leaves the transaction, rolling back everything written so far, and makes `withUserLocks` return
  this error tuple. Utilities here never throw at their callers; this is a throw within one
  function's own transaction, caught a few lines below.
*/
export const abort = (code, msg, extra = {}) => {
  throw new Abort([{ code, msg, ...extra }, null]);
};

const errorCode = error => error?.code || error?.cause?.code;

export const isUniqueViolation = error => errorCode(error) === '23505';

export const withUserLocks = async (userIds, work, { conflict = 'That was already done' } = {}) => {
  try {
    return await db.transaction(async tx => {
      for(const id of [...new Set(userIds)].sort()){
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`kempo-credits:${id}`}, 0))`);
      }

      const result = await work(tx);
      if(result?.[0]) throw new Abort(result);
      return result;
    });
  } catch(error) {
    if(error instanceof Abort) return error.result;

    /*
      The lock should make this unreachable: a second use of an idempotency key waits for the first
      and then finds it. It is here because the index is the guarantee and the lock is the speed,
      and a guarantee that only reports itself as a 500 is not much of one.
    */
    if(isUniqueViolation(error)) return [{ code: 409, msg: conflict }, null];

    console.error(`[kempo-credits] Ledger transaction failed: ${error?.message ?? error}`);
    return [{ code: 500, msg: 'The credits ledger could not be updated' }, null];
  }
};
