import grantCredits from '../server/utils/ledger/grant.js';
import spendCredits from '../server/utils/ledger/spend.js';
import transferCredits from '../server/utils/ledger/transfer.js';
import { clawBackGrant } from '../server/utils/ledger/clawback.js';
import { getBalance, listEntries } from '../server/utils/ledger/read.js';
import { integrationTier } from './helpers/db.js';
import { freshUser, invariant, key, purge } from './helpers/ledger.js';

/*
  Requests that arrive at the same moment. The guarantee here is the one the extension exists for:
  however many spends race for the same credits, the ledger never pays out more than it holds, and
  however many times the same request arrives, it is applied once.

  Each case fires its requests with Promise.all, so they are all in flight together. In the unit tier
  that is one in-memory database connection, where transactions take turns no matter what — it
  proves the logic, not the locking. In the integration tier (`npm run test:integration`) every
  request has its own connection to a real Postgres and they genuinely race, and that is the run
  that proves the lock.
*/

const REF = { owner: 'test', ref: 'race' };

const grant = (userId, amount, extra = {}) => grantCredits({
  userId, amount, reason: 'test', idempotencyKey: key(), ...extra,
});

const spend = (userId, amount, extra = {}) => spendCredits({
  userId, amount, reason: 'test', reference: REF, idempotencyKey: key(), ...extra,
});

const tally = results => ({
  ok: results.filter(([error]) => !error),
  short: results.filter(([error]) => error?.code === 402),
  other: results.filter(([error]) => error && error.code !== 402),
});

export const beforeAll = purge;
export const afterAll = purge;

export default {
  'two simultaneous spends of the last 100 credits: exactly one succeeds': async ({ pass, fail }) => {
    const ROUNDS = 10;

    for(let round = 0; round < ROUNDS; round++){
      const user = freshUser();
      await grant(user, 100);

      const { ok, short, other } = tally(await Promise.all([spend(user, 100), spend(user, 100)]));
      if(other.length) return fail(`round ${round}: ${other[0][0].code} ${other[0][0].msg}`);
      if(ok.length !== 1 || short.length !== 1) return fail(`round ${round}: ${ok.length} succeeded and ${short.length} were refused`);

      const [, balance] = await getBalance({ userId: user });
      if(balance.total !== 0) return fail(`round ${round}: balance is ${balance.total}`);
      const problem = await invariant(user);
      if(problem) return fail(`round ${round}: ${problem}`);
    }

    pass(`${ROUNDS} rounds${integrationTier ? ' on a real Postgres' : ''}`);
  },

  'twenty-five racing spends of 10 from a balance of 100: exactly ten succeed': async ({ pass, fail }) => {
    const user = freshUser();
    await grant(user, 60);
    await grant(user, 40, { kind: 'promo' });

    const results = await Promise.all(Array.from({ length: 25 }, () => spend(user, 10)));
    const { ok, short, other } = tally(results);
    if(other.length) return fail(`${other[0][0].code} ${other[0][0].msg}`);
    if(ok.length !== 10 || short.length !== 15) return fail(`${ok.length} succeeded and ${short.length} were refused`);

    const [, balance] = await getBalance({ userId: user });
    if(balance.total !== 0) return fail(`balance is ${balance.total}`);
    const problem = await invariant(user);
    if(problem) return fail(problem);
    pass('');
  },

  'the same spend sent ten times at once is spent once': async ({ pass, fail }) => {
    const user = freshUser();
    await grant(user, 100);
    const idempotencyKey = key();

    const results = await Promise.all(Array.from({ length: 10 }, () => spend(user, 30, { idempotencyKey })));
    const errors = results.filter(([error]) => error);
    if(errors.length) return fail(`${errors.length} failed: ${errors[0][0].msg}`);

    const fresh = results.filter(([, result]) => !result.duplicate);
    if(fresh.length !== 1) return fail(`${fresh.length} of the ten were applied`);
    if(new Set(results.map(([, result]) => result.operationId)).size !== 1) return fail('they did not all report the same operation');

    const [, balance] = await getBalance({ userId: user });
    if(balance.total !== 70) return fail(`balance is ${balance.total}`);
    pass('');
  },

  'a grant delivered five times at once — a redelivered webhook — grants once': async ({ pass, fail }) => {
    const user = freshUser();
    const idempotencyKey = `payment:${key()}`;

    const results = await Promise.all(Array.from({ length: 5 }, () => grant(user, 500, { idempotencyKey })));
    const errors = results.filter(([error]) => error);
    if(errors.length) return fail(`${errors.length} failed: ${errors[0][0].msg}`);
    if(new Set(results.map(([, result]) => result.lot.id)).size !== 1) return fail('more than one lot was created');

    const [, balance] = await getBalance({ userId: user });
    if(balance.total !== 500) return fail(`balance is ${balance.total}`);
    const [, grants] = await listEntries({ userId: user, type: 'grant' });
    if(grants.total !== 1) return fail(`${grants.total} grant entries`);
    pass('');
  },

  'a refund racing spends never lets a spent credit go uncounted': async ({ pass, fail }) => {
    const user = freshUser();
    const [, bought] = await grant(user, 100);

    const results = await Promise.all([
      spend(user, 30),
      spend(user, 30),
      clawBackGrant({ lotId: bought.lot.id }),
      spend(user, 30),
      spend(user, 30),
    ]);

    const [clawError, clawed] = results[2];
    if(clawError) return fail(clawError.msg);
    const spends = [results[0], results[1], results[3], results[4]];
    const spent = spends.filter(([error]) => !error).length * 30;
    const other = spends.filter(([error]) => error && error.code !== 402);
    if(other.length) return fail(other[0][0].msg);

    if(clawed.taken + clawed.shortfall !== 100) return fail(`the claw back covered ${clawed.taken + clawed.shortfall} of 100`);
    if(clawed.shortfall !== spent) return fail(`${spent} was spent but the shortfall is ${clawed.shortfall}`);

    const [, balance] = await getBalance({ userId: user });
    if(balance.total !== -spent) return fail(`balance is ${balance.total}, expected -${spent}`);
    const problem = await invariant(user);
    if(problem) return fail(problem);
    pass(`${spent} spent before the claw back`);
  },

  /*
    Two transfers that each need the other user's lock. Locks are taken in sorted order precisely so
    this cannot deadlock; a version that locked "sender first" would hang or abort here, on a real
    database, some of the time — so it runs many rounds.
  */
  'A sending to B while B sends to A, many times over, never deadlocks and never loses a credit': async ({ pass, fail }) => {
    const ROUNDS = 12;

    for(let round = 0; round < ROUNDS; round++){
      const [alice, bob] = [freshUser(), freshUser()];
      await grant(alice, 100);
      await grant(bob, 100);

      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => transferCredits({ fromUserId: alice, toUserId: bob, amount: 10, reason: 'gift', idempotencyKey: key() })),
        ...Array.from({ length: 4 }, () => transferCredits({ fromUserId: bob, toUserId: alice, amount: 10, reason: 'gift', idempotencyKey: key() })),
      ]);

      const failed = results.filter(([error]) => error);
      if(failed.length) return fail(`round ${round}: ${failed[0][0].code} ${failed[0][0].msg}`);

      const [, a] = await getBalance({ userId: alice });
      const [, b] = await getBalance({ userId: bob });
      if(a.total + b.total !== 200 || a.total !== 100) return fail(`round ${round}: alice ${a.total}, bob ${b.total}`);
      for(const user of [alice, bob]){
        const problem = await invariant(user);
        if(problem) return fail(`round ${round}: ${problem}`);
      }
    }

    pass(`${ROUNDS} rounds${integrationTier ? ' on a real Postgres' : ''}`);
  },

  'racing transfers of the same credits send them once': async ({ pass, fail }) => {
    const [alice, bob, carol] = [freshUser(), freshUser(), freshUser()];
    await grant(alice, 100);

    const results = await Promise.all([
      transferCredits({ fromUserId: alice, toUserId: bob, amount: 100, reason: 'gift', idempotencyKey: key() }),
      transferCredits({ fromUserId: alice, toUserId: carol, amount: 100, reason: 'gift', idempotencyKey: key() }),
      spend(alice, 100),
    ]);

    const succeeded = results.filter(([error]) => !error).length;
    const short = results.filter(([error]) => error?.code === 402).length;
    if(succeeded !== 1 || short !== 2) return fail(`${succeeded} succeeded and ${short} were refused`);

    const totals = await Promise.all([alice, bob, carol].map(async user => (await getBalance({ userId: user }))[1].total));
    if(totals.reduce((sum, total) => sum + total, 0) !== (results[2][0] ? 100 : 0) || totals[0] !== 0){
      return fail(`balances ${totals.join(', ')} after ${succeeded} success`);
    }
    pass('');
  },

  'one transfer sent six times at once is sent once': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 100);
    const idempotencyKey = key();

    const results = await Promise.all(Array.from({ length: 6 }, () => transferCredits({
      fromUserId: alice, toUserId: bob, amount: 40, reason: 'gift', idempotencyKey,
    })));
    const errors = results.filter(([error]) => error);
    if(errors.length) return fail(`${errors.length} failed: ${errors[0][0].msg}`);
    if(results.filter(([, sent]) => !sent.duplicate).length !== 1) return fail('more than one was applied');
    if(new Set(results.map(([, sent]) => sent.operationId)).size !== 1) return fail('they did not all report one operation');

    const [, b] = await getBalance({ userId: bob });
    if(b.total !== 40) return fail(`bob has ${b.total}`);
    pass('');
  },
};
