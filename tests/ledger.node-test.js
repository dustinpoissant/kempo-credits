import { eq } from 'drizzle-orm';
import { kempoCreditEntry, kempoCreditLot } from '../server/db/schema.js';
import grantCredits from '../server/utils/ledger/grant.js';
import spendCredits from '../server/utils/ledger/spend.js';
import reverseSpend from '../server/utils/ledger/reverse.js';
import clawBackGrant from '../server/utils/ledger/clawback.js';
import { forgiveDebt, removeCredits } from '../server/utils/ledger/adjust.js';
import { auditAccount, expireLots, getBalance, getLot, getOperation, listEntries } from '../server/utils/ledger/read.js';
import { db } from './helpers/db.js';
import { freshUser, heard, invariant, key, listenToHooks, purge, stopListening, withSetting } from './helpers/ledger.js';

/*
  The ledger, one operation at a time: what each one writes, what it refuses, and that the balance
  is still exactly the sum of the lots afterwards. Concurrency has its own suite.
*/

const REF = { owner: 'test', ref: 'thing-1' };

const grant = (userId, amount, extra = {}) => grantCredits({
  userId, amount, kind: 'promo', reason: 'test', idempotencyKey: key(), ...extra,
});

const spend = (userId, amount, extra = {}) => spendCredits({
  userId, amount, reason: 'test', reference: REF, idempotencyKey: key(), ...extra,
});

const ageLot = (lotId, ms = 1000) => db.update(kempoCreditLot)
  .set({ expiresAt: new Date(Date.now() - ms) })
  .where(eq(kempoCreditLot.id, lotId));

const check = async (userId, fail) => {
  const problem = await invariant(userId);
  if(problem){
    fail(`invariant broken: ${problem}`);
    return false;
  }
  return true;
};

export const beforeAll = async () => {
  await purge();
  await listenToHooks();
};

export const afterAll = async () => {
  await stopListening();
  await purge();
};

export default {
  'a grant creates a lot, an entry and a balance': async ({ pass, fail }) => {
    const user = freshUser();
    const [error, result] = await grant(user, 500, { kind: 'paid', reason: 'purchase', reference: { owner: 'kempo-credits', ref: 'pur_1' } });
    if(error) return fail(error.msg);

    if(result.lot.amount !== 500 || result.lot.remaining !== 500) return fail(`lot is ${result.lot.amount}/${result.lot.remaining}`);
    if(result.lot.kind !== 'paid') return fail('kind was not kept');
    if(result.lot.expiresAt !== null) return fail('a paid lot got an expiry');
    if(result.balance.total !== 500 || result.balance.paid !== 500 || result.balance.promo !== 0) return fail(`balance is ${JSON.stringify(result.balance)}`);

    const entries = await db.select().from(kempoCreditEntry).where(eq(kempoCreditEntry.lotId, result.lot.id));
    if(entries.length !== 1 || entries[0].type !== 'grant' || entries[0].amount !== 500) return fail('the grant entry is wrong');
    if(entries[0].referenceOwner !== 'kempo-credits' || entries[0].referenceId !== 'pur_1') return fail('the reference was not recorded');

    if(!await check(user, fail)) return;
    pass('');
  },

  'a grant refuses what it cannot record honestly': async ({ pass, fail }) => {
    const user = freshUser();
    const cases = [
      [{ amount: 12.5 }, 400, 'a fractional amount'],
      [{ amount: 0 }, 400, 'zero'],
      [{ amount: -5 }, 400, 'a negative amount'],
      [{ amount: '100' }, 400, 'an amount as a string'],
      [{ amount: 2000000000 }, 400, 'an amount over the maximum'],
      [{ kind: 'gift' }, 400, 'an unknown kind'],
      [{ reason: '' }, 400, 'no reason'],
      [{ idempotencyKey: '' }, 400, 'no key'],
      [{ idempotencyKey: 'a\u0000b' }, 400, 'a NUL byte in the key'],
      [{ reference: { owner: 'x' } }, 400, 'a reference with no ref'],
      [{ reference: 'pur_1' }, 400, 'a reference that is not an object'],
      [{ kind: 'paid', expiresInDays: 30 }, 400, 'an expiry on paid credits'],
      [{ expiresAt: new Date(Date.now() - 1000) }, 400, 'an expiry in the past'],
      [{ expiresAt: 'not a date' }, 400, 'an expiry that is not a date'],
      [{ expiresAt: new Date(Date.now() + 1000), expiresInDays: 3 }, 400, 'two expiries'],
    ];

    for(const [overrides, code, label] of cases){
      const [error] = await grantCredits({ userId: user, amount: 100, kind: 'promo', reason: 'test', idempotencyKey: key(), ...overrides });
      if(error?.code !== code) return fail(`${label}: expected ${code}, got ${error ? error.code : 'success'}`);
    }

    const [, balance] = await getBalance({ userId: user });
    if(balance.total !== 0) return fail('a refused grant left credits behind');
    pass(`${cases.length} refusals`);
  },

  'granting twice under one key grants once': async ({ pass, fail }) => {
    const user = freshUser();
    const idempotencyKey = key();
    globalThis.kempoCreditsHooks = [];

    const [firstError, first] = await grant(user, 250, { idempotencyKey });
    const [secondError, second] = await grant(user, 250, { idempotencyKey });
    if(firstError || secondError) return fail((firstError || secondError).msg);

    if(first.duplicate) return fail('the first grant says it was a duplicate');
    if(!second.duplicate) return fail('the second grant does not say it was a duplicate');
    if(second.lot.id !== first.lot.id) return fail('the retry made a second lot');
    if(second.balance.total !== 250) return fail(`balance is ${second.balance.total}`);
    if(heard('credits:granted', user).length !== 1) return fail(`credits:granted fired ${heard('credits:granted', user).length} times`);

    const [conflict] = await grant(user, 300, { idempotencyKey });
    if(conflict?.code !== 409) return fail('the same key for a different amount was not refused');

    const [misuse] = await spend(user, 10, { idempotencyKey });
    if(misuse?.code !== 409) return fail('a grant key reused for a spend was not refused');

    if(!await check(user, fail)) return;
    pass('');
  },

  'credits are spent soonest-expiring first, promo before paid, oldest first': async ({ pass, fail }) => {
    const user = freshUser();
    const [, paidOld] = await grant(user, 100, { kind: 'paid' });
    const [, promoForever] = await grant(user, 100, { kind: 'promo' });
    const [, promoLate] = await grant(user, 100, { kind: 'promo', expiresInDays: 60 });
    const [, promoSoon] = await grant(user, 100, { kind: 'promo', expiresInDays: 5 });
    const [, paidNew] = await grant(user, 100, { kind: 'paid' });

    const [error, spent] = await spend(user, 450);
    if(error) return fail(error.msg);

    const drawn = spent.entries.map(entry => [entry.lotId, -entry.amount]);
    const expected = [
      [promoSoon.lot.id, 100],     // expires soonest
      [promoLate.lot.id, 100],     // expires next
      [promoForever.lot.id, 100],  // never expires: promo before paid
      [paidOld.lot.id, 100],       // then paid, oldest first
      [paidNew.lot.id, 50],
    ];
    if(JSON.stringify(drawn) !== JSON.stringify(expected)){
      return fail(`drew ${JSON.stringify(drawn)}, expected ${JSON.stringify(expected)}`);
    }
    if(spent.balance.total !== 50 || spent.balance.paid !== 50) return fail(`balance is ${JSON.stringify(spent.balance)}`);
    if(spent.entries.filter(entry => entry.idempotencyKey).length !== 1) return fail('the key should be on exactly one entry of the operation');

    if(!await check(user, fail)) return;
    pass('');
  },

  'a spend that cannot be covered takes nothing': async ({ pass, fail }) => {
    const user = freshUser();
    await grant(user, 60);
    await grant(user, 30, { kind: 'paid' });

    const [error] = await spend(user, 100);
    if(error?.code !== 402) return fail(`expected 402, got ${error?.code ?? 'success'}`);
    if(error.balance !== 90 || error.needed !== 100) return fail(`the error does not say how short: ${JSON.stringify(error)}`);

    const [, balance] = await getBalance({ userId: user });
    if(balance.total !== 90) return fail(`a refused spend changed the balance to ${balance.total}`);

    const spends = await db.select().from(kempoCreditEntry).where(eq(kempoCreditEntry.userId, user));
    if(spends.some(entry => entry.type === 'spend')) return fail('a refused spend wrote an entry');

    const [noRef] = await spendCredits({ userId: user, amount: 5, reason: 'x', idempotencyKey: key() });
    if(noRef?.code !== 400) return fail('a spend with no reference was accepted');

    if(!await check(user, fail)) return;
    pass('');
  },

  'spending twice under one key spends once': async ({ pass, fail }) => {
    const user = freshUser();
    await grant(user, 100);
    const idempotencyKey = key();
    globalThis.kempoCreditsHooks = [];

    const [, first] = await spend(user, 40, { idempotencyKey });
    const [error, second] = await spend(user, 40, { idempotencyKey });
    if(error) return fail(error.msg);
    if(!second.duplicate || second.operationId !== first.operationId) return fail('the retry was not recognised');
    if(second.balance.total !== 60) return fail(`balance is ${second.balance.total}`);
    if(heard('credits:spent', user).length !== 1) return fail('credits:spent fired for the retry');

    const [conflict] = await spend(user, 41, { idempotencyKey });
    if(conflict?.code !== 409) return fail('the same key for a different amount was not refused');

    if(!await check(user, fail)) return;
    pass('');
  },

  'a reversal puts every credit back in the lot it came from': async ({ pass, fail }) => {
    const user = freshUser();
    const [, promo] = await grant(user, 50, { kind: 'promo', expiresInDays: 10 });
    const [, paid] = await grant(user, 100, { kind: 'paid' });
    const idempotencyKey = key();
    await spend(user, 120, { idempotencyKey });
    await spend(user, 10);

    const [error, reversed] = await reverseSpend({ userId: user, idempotencyKey });
    if(error) return fail(error.msg);
    if(reversed.amount !== 120) return fail(`reversed ${reversed.amount}`);

    const [, promoLot] = await getLot({ lotId: promo.lot.id });
    const [, paidLot] = await getLot({ lotId: paid.lot.id });
    if(promoLot.remaining !== 50) return fail(`promo lot has ${promoLot.remaining}, expected 50 back`);
    if(paidLot.remaining !== 20 + 70) return fail(`paid lot has ${paidLot.remaining}`);

    const [, again] = await reverseSpend({ userId: user, idempotencyKey });
    if(!again.duplicate) return fail('reversing twice was not recognised');
    const [, balance] = await getBalance({ userId: user });
    if(balance.total !== 140) return fail(`balance is ${balance.total} after a repeated reversal`);

    const [, operation] = await getOperation({ operationId: reversed.reversedOperationId });
    if(operation.reversedBy !== reversed.operationId) return fail('the spend does not know it was reversed');

    const [missing] = await reverseSpend({ userId: user, idempotencyKey: key() });
    if(missing?.code !== 404) return fail('reversing an unknown key was not a 404');

    if(!await check(user, fail)) return;
    pass('');
  },

  'only a spend can be reversed': async ({ pass, fail }) => {
    const user = freshUser();
    const idempotencyKey = key();
    await grant(user, 50, { idempotencyKey });
    const [error] = await reverseSpend({ userId: user, idempotencyKey });
    if(error?.code !== 400) return fail(`reversing a grant gave ${error?.code ?? 'success'}`);
    pass('');
  },

  'an expired lot stops counting at once, and is written off on the next operation': async ({ pass, fail }) => {
    const user = freshUser();
    const [, short] = await grant(user, 70, { expiresInDays: 1 });
    await grant(user, 30, { kind: 'paid' });
    await ageLot(short.lot.id);

    const [, before] = await getBalance({ userId: user });
    if(before.total !== 30) return fail(`an expired lot still counts: balance ${before.total}`);

    const [spendError] = await spend(user, 40);
    if(spendError?.code !== 402) return fail('expired credits were spent');

    /*
      A refused operation rolls back everything it wrote, the write-off included — the balance never
      depended on it. The next operation that succeeds records it.
    */
    const [okError] = await spend(user, 10);
    if(okError) return fail(okError.msg);

    const entries = await db.select().from(kempoCreditEntry).where(eq(kempoCreditEntry.lotId, short.lot.id));
    const expiry = entries.find(entry => entry.type === 'expiry');
    if(!expiry || expiry.amount !== -70) return fail('the expiry was not written to the ledger');

    if(!await check(user, fail)) return;
    pass('');
  },

  'credits returned to an expired lot expire again': async ({ pass, fail }) => {
    const user = freshUser();
    const [, promo] = await grant(user, 40, { expiresInDays: 2 });
    const idempotencyKey = key();
    await spend(user, 40, { idempotencyKey });
    await ageLot(promo.lot.id);

    const [error, reversed] = await reverseSpend({ userId: user, idempotencyKey });
    if(error) return fail(error.msg);
    if(reversed.expired !== 40) return fail(`expected 40 to expire again, got ${reversed.expired}`);
    if(reversed.balance.total !== 0) return fail(`balance is ${reversed.balance.total}`);

    if(!await check(user, fail)) return;
    pass('');
  },

  'expireLots writes off every user\'s expired lots': async ({ pass, fail }) => {
    const users = [freshUser(), freshUser()];
    for(const user of users){
      const [, lot] = await grant(user, 25, { expiresInDays: 1 });
      await ageLot(lot.lot.id);
    }

    const [error, swept] = await expireLots();
    if(error) return fail(error.msg);
    if(swept.users < 2 || swept.credits < 50) return fail(`swept ${JSON.stringify(swept)}`);

    for(const user of users){
      const [, entries] = await listEntries({ userId: user, type: 'expiry' });
      if(entries.total !== 1) return fail(`${user} has ${entries.total} expiry entries`);
      if(!await check(user, fail)) return;
    }

    const [, again] = await expireLots();
    if(again.credits !== 0) return fail('a second sweep expired something again');
    pass('');
  },

  'the balance reports what is expiring soon': async ({ pass, fail }) => {
    const user = freshUser();
    await grant(user, 10, { expiresInDays: 3 });
    await grant(user, 20, { expiresInDays: 100 });
    await grant(user, 40, { kind: 'paid' });

    const [, balance] = await getBalance({ userId: user });
    if(balance.expiringSoon !== 10) return fail(`expiringSoon is ${balance.expiringSoon}`);
    const days = (new Date(balance.nextExpiresAt) - Date.now()) / 86400000;
    if(days < 2.9 || days > 3.1) return fail(`nextExpiresAt is ${balance.nextExpiresAt}`);

    const wider = await withSetting('expiring_soon_days', 200, 'number', () => getBalance({ userId: user }));
    if(wider[1].expiringSoon !== 30) return fail(`with a 200-day window expiringSoon is ${wider[1].expiringSoon}`);
    pass('');
  },

  'clawing back an unspent grant takes all of it': async ({ pass, fail }) => {
    const user = freshUser();
    const reference = { owner: 'kempo-credits', ref: `pur_${key()}` };
    await grant(user, 300, { kind: 'paid', reference });
    await grant(user, 50);

    const [error, result] = await clawBackGrant({ reference });
    if(error) return fail(error.msg);
    if(result.taken !== 300 || result.shortfall !== 0) return fail(`took ${result.taken}, short ${result.shortfall}`);
    if(result.balance.total !== 50) return fail(`balance is ${result.balance.total}`);

    const [again] = await clawBackGrant({ reference });
    if(again?.code !== 409) return fail('clawing back the same grant twice was not refused');

    if(!await check(user, fail)) return;
    pass('');
  },

  'a refund of credits already spent leaves the user owing, and blocks spending': async ({ pass, fail }) => {
    const user = freshUser();
    globalThis.kempoCreditsHooks = [];
    const [, bought] = await grant(user, 100, { kind: 'paid' });
    await spend(user, 70);

    const [error, result] = await clawBackGrant({ lotId: bought.lot.id });
    if(error) return fail(error.msg);
    if(result.taken !== 30 || result.shortfall !== 70) return fail(`took ${result.taken}, short ${result.shortfall}`);
    if(result.owed !== 70 || result.balance.total !== -70) return fail(`owed ${result.owed}, balance ${result.balance.total}`);
    if(result.lot.remaining !== -70) return fail(`the lot shows ${result.lot.remaining}`);

    const [blocked] = await spend(user, 1);
    if(blocked?.code !== 402 || blocked.owed !== 70) return fail(`a user who owes could spend: ${JSON.stringify(blocked)}`);

    const fired = heard('credits:clawed-back', user);
    if(fired.length !== 1 || fired[0].data.shortfall !== 70) return fail('credits:clawed-back did not report the shortfall');

    if(!await check(user, fail)) return;
    pass('');
  },

  'a shortfall is paid from the user\'s other credits first': async ({ pass, fail }) => {
    const user = freshUser();
    const [, first] = await grant(user, 100, { kind: 'paid' });
    await grant(user, 100, { kind: 'paid' });
    await spend(user, 150);

    const [error, result] = await clawBackGrant({ lotId: first.lot.id });
    if(error) return fail(error.msg);
    if(result.shortfall !== 100 || result.settled !== 50 || result.owed !== 50) {
      return fail(`short ${result.shortfall}, settled ${result.settled}, owed ${result.owed}`);
    }
    if(result.balance.total !== -50) return fail(`balance is ${result.balance.total}`);

    if(!await check(user, fail)) return;
    pass('');
  },

  'credits granted to a user who owes pay the debt off first': async ({ pass, fail }) => {
    const user = freshUser();
    const [, bought] = await grant(user, 100, { kind: 'paid' });
    await spend(user, 100);
    await clawBackGrant({ lotId: bought.lot.id });

    const [error, granted] = await grant(user, 30);
    if(error) return fail(error.msg);
    if(granted.settled !== 30 || granted.balance.total !== -70) return fail(`settled ${granted.settled}, balance ${granted.balance.total}`);

    const [, more] = await grant(user, 500, { kind: 'paid' });
    if(more.settled !== 70 || more.balance.total !== 430 || more.balance.owed !== 0) {
      return fail(`settled ${more.settled}, balance ${JSON.stringify(more.balance)}`);
    }

    const [spendError] = await spend(user, 430);
    if(spendError) return fail(`could not spend once the debt was paid: ${spendError.msg}`);

    if(!await check(user, fail)) return;
    pass('');
  },

  'partial claw backs add up to the whole grant': async ({ pass, fail }) => {
    const user = freshUser();
    const [, bought] = await grant(user, 1000, { kind: 'paid' });
    await spend(user, 600);

    const [, half] = await clawBackGrant({ lotId: bought.lot.id, amount: 500 });
    if(half.taken !== 400 || half.shortfall !== 100) return fail(`first half: took ${half.taken}, short ${half.shortfall}`);

    const [, rest] = await clawBackGrant({ lotId: bought.lot.id, amount: 500 });
    if(rest.taken !== 0 || rest.shortfall !== 500) return fail(`second half: took ${rest.taken}, short ${rest.shortfall}`);
    if(rest.balance.total !== -600) return fail(`balance is ${rest.balance.total}, expected exactly what was spent`);

    const [over] = await clawBackGrant({ lotId: bought.lot.id, amount: 1 });
    if(over?.code !== 409) return fail('clawed back more than was granted');

    if(!await check(user, fail)) return;
    pass('');
  },

  'credits that expired are not counted against the user': async ({ pass, fail }) => {
    const user = freshUser();
    const [, promo] = await grant(user, 100, { expiresInDays: 1 });
    await spend(user, 30);
    await ageLot(promo.lot.id);

    const [error, result] = await clawBackGrant({ lotId: promo.lot.id });
    if(error) return fail(error.msg);
    if(result.clawedBack !== 30 || result.shortfall !== 30) return fail(`clawed back ${result.clawedBack}, short ${result.shortfall}`);

    if(!await check(user, fail)) return;
    pass('');
  },

  'a claw back under a key is done once': async ({ pass, fail }) => {
    const user = freshUser();
    const [, bought] = await grant(user, 100, { kind: 'paid' });
    const idempotencyKey = key();

    await clawBackGrant({ lotId: bought.lot.id, amount: 40, idempotencyKey });
    const [error, again] = await clawBackGrant({ lotId: bought.lot.id, amount: 40, idempotencyKey });
    if(error) return fail(error.msg);
    if(!again.duplicate) return fail('the retry was not recognised');
    if(again.balance.total !== 60) return fail(`balance is ${again.balance.total}`);
    pass('');
  },

  'a reference that matches two grants is refused rather than guessed': async ({ pass, fail }) => {
    const user = freshUser();
    const reference = { owner: 'test', ref: `dup-${key()}` };
    await grant(user, 10, { reference });
    await grant(user, 10, { reference });
    const [error] = await clawBackGrant({ reference });
    if(error?.code !== 409) return fail(`got ${error?.code ?? 'success'}`);
    pass('');
  },

  'an administrator can remove credits, and write off a debt': async ({ pass, fail }) => {
    const user = freshUser();
    await grant(user, 100);
    const [removeError, removed] = await removeCredits({ userId: user, amount: 40, note: 'duplicate grant', idempotencyKey: key(), actorId: 'admin-1' });
    if(removeError) return fail(removeError.msg);
    if(removed.balance.total !== 60) return fail(`balance is ${removed.balance.total}`);
    if(removed.entries[0].actorId !== 'admin-1' || removed.entries[0].note !== 'duplicate grant') return fail('who and why were not recorded');

    const [tooMuch] = await removeCredits({ userId: user, amount: 61, note: 'x', idempotencyKey: key() });
    if(tooMuch?.code !== 402) return fail('removed more than the user had');
    const [noNote] = await removeCredits({ userId: user, amount: 1, idempotencyKey: key() });
    if(noNote?.code !== 400) return fail('a removal with no note was accepted');

    const [, bought] = await grant(user, 100, { kind: 'paid' });
    await spend(user, 160);
    await clawBackGrant({ lotId: bought.lot.id });

    const [, part] = await forgiveDebt({ userId: user, amount: 40, note: 'goodwill', idempotencyKey: key() });
    if(part.balance.owed !== 60) return fail(`after writing off 40, owed ${part.balance.owed}`);
    const [, all] = await forgiveDebt({ userId: user, note: 'goodwill', idempotencyKey: key() });
    if(all.balance.owed !== 0 || all.balance.total !== 0) return fail(`after writing off the rest, ${JSON.stringify(all.balance)}`);
    const [nothing] = await forgiveDebt({ userId: user, note: 'x', idempotencyKey: key() });
    if(nothing?.code !== 409) return fail('wrote off a debt that did not exist');

    if(!await check(user, fail)) return;
    pass('');
  },

  'credits:low fires once each time the balance crosses the threshold': async ({ pass, fail }) => {
    const user = freshUser();
    await withSetting('low_balance_threshold', 50, 'number', async () => {
      globalThis.kempoCreditsHooks = [];
      await grant(user, 100);
      await spend(user, 40);   // 60: above
      await spend(user, 20);   // 40: crossed
      await spend(user, 10);   // 30: still below
      await grant(user, 100);  // 130: back above
      await spend(user, 90);   // 40: crossed again
    });

    const low = heard('credits:low', user);
    if(low.length !== 2) return fail(`fired ${low.length} times, expected 2`);
    if(low[0].data.balance.total !== 40 || low[0].data.threshold !== 50) return fail(`payload ${JSON.stringify(low[0].data)}`);
    pass('');
  },

  'every operation fires its hook once, after it is committed': async ({ pass, fail }) => {
    const user = freshUser();
    globalThis.kempoCreditsHooks = [];
    const idempotencyKey = key();

    await grant(user, 100);
    await spend(user, 30, { idempotencyKey });
    await reverseSpend({ userId: user, idempotencyKey });

    for(const event of ['credits:granted', 'credits:spent', 'credits:reversed']){
      if(heard(event, user).length !== 1) return fail(`${event} fired ${heard(event, user).length} times`);
    }
    const spent = heard('credits:spent', user)[0].data;
    if(spent.balance.total !== 70 || spent.reference.ref !== REF.ref) return fail(`credits:spent payload ${JSON.stringify(spent)}`);
    pass('');
  },

  'the audit notices a balance edited behind the ledger\'s back': async ({ pass, fail }) => {
    const user = freshUser();
    const [, granted] = await grant(user, 100);
    await db.update(kempoCreditLot).set({ remaining: 1000 }).where(eq(kempoCreditLot.id, granted.lot.id));

    const [error, audit] = await auditAccount({ userId: user });
    if(error) return fail(error.msg);
    if(audit.ok || !audit.problems[0]?.includes('1000')) return fail(`audit said ${JSON.stringify(audit)}`);
    pass('');
  },
};
