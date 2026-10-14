import { eq } from 'drizzle-orm';
import { kempoCreditEntry, kempoCreditLot } from '../server/db/schema.js';
import grantCredits from '../server/utils/ledger/grant.js';
import spendCredits from '../server/utils/ledger/spend.js';
import reverseSpend from '../server/utils/ledger/reverse.js';
import { clawBackGrant } from '../server/utils/ledger/clawback.js';
import { forgiveDebt, removeCredits } from '../server/utils/ledger/adjust.js';
import { auditAccount, getBalance, getLot, getOperation, listEntries } from '../server/utils/ledger/read.js';
import { db } from './helpers/db.js';
import { freshUser, heard, invariant, key, listenToHooks, purge, stopListening, withSetting } from './helpers/ledger.js';

/*
  The ledger, one operation at a time: what each one writes, what it refuses, and that the balance
  is still exactly the sum of the lots afterwards. Concurrency has its own suite.
*/

const REF = { owner: 'test', ref: 'thing-1' };

const grant = (userId, amount, extra = {}) => grantCredits({
  userId, amount, reason: 'test', idempotencyKey: key(), ...extra,
});

const spend = (userId, amount, extra = {}) => spendCredits({
  userId, amount, reason: 'test', reference: REF, idempotencyKey: key(), ...extra,
});

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
    const [error, result] = await grant(user, 500, { kind: 'purchase', reason: 'purchase', reference: { owner: 'kempo-credit-packs', ref: 'pur_1' } });
    if(error) return fail(error.msg);

    if(result.lot.amount !== 500 || result.lot.remaining !== 500) return fail(`lot is ${result.lot.amount}/${result.lot.remaining}`);
    if(result.lot.kind !== 'purchase') return fail('kind was not kept');
    if('expiresAt' in result.lot) return fail('a lot has an expiry');
    if(result.balance.total !== 500 || result.balance.byKind.purchase !== 500) return fail(`balance is ${JSON.stringify(result.balance)}`);

    const entries = await db.select().from(kempoCreditEntry).where(eq(kempoCreditEntry.lotId, result.lot.id));
    if(entries.length !== 1 || entries[0].type !== 'grant' || entries[0].amount !== 500) return fail('the grant entry is wrong');
    if(entries[0].referenceOwner !== 'kempo-credit-packs' || entries[0].referenceId !== 'pur_1') return fail('the reference was not recorded');

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
      [{ kind: 'Gift Card' }, 400, 'a kind that is not a label'],
      [{ reason: '' }, 400, 'no reason'],
      [{ idempotencyKey: '' }, 400, 'no key'],
      [{ idempotencyKey: 'a\u0000b' }, 400, 'a NUL byte in the key'],
      [{ reference: { owner: 'x' } }, 400, 'a reference with no ref'],
      [{ reference: 'pur_1' }, 400, 'a reference that is not an object'],
      [{ kind: 'paid', expiresInDays: 30 }, 400, 'an expiry on paid credits'],
      [{ expiresInDays: 30 }, 400, 'an expiry on promo credits'],
      [{ expiresAt: new Date(Date.now() + 86400000) }, 400, 'an expiry date'],
    ];

    for(const [overrides, code, label] of cases){
      const [error] = await grantCredits({ userId: user, amount: 100, reason: 'test', idempotencyKey: key(), ...overrides });
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

  'credits are spent oldest first, whatever their kind': async ({ pass, fail }) => {
    const user = freshUser();
    const [, first] = await grant(user, 100, { kind: 'purchase' });
    const [, second] = await grant(user, 100, { kind: 'achievement' });
    const [, third] = await grant(user, 100, { kind: 'purchase' });

    const [error, spent] = await spend(user, 250);
    if(error) return fail(error.msg);

    const drawn = spent.entries.map(entry => [entry.lotId, -entry.amount]);
    const expected = [[first.lot.id, 100], [second.lot.id, 100], [third.lot.id, 50]];
    if(JSON.stringify(drawn) !== JSON.stringify(expected)){
      return fail(`drew ${JSON.stringify(drawn)}, expected ${JSON.stringify(expected)}`);
    }
    if(spent.balance.total !== 50 || spent.balance.byKind.purchase !== 50 || 'achievement' in spent.balance.byKind){
      return fail(`balance is ${JSON.stringify(spent.balance)}`);
    }
    if(spent.entries.filter(entry => entry.idempotencyKey).length !== 1) return fail('the key should be on exactly one entry of the operation');

    if(!await check(user, fail)) return;
    pass('');
  },

  'a kind is a label: unset is general, anything lowercase goes, nothing else': async ({ pass, fail }) => {
    const user = freshUser();
    const [, plain] = await grant(user, 10);
    if(plain.lot.kind !== 'general') return fail(`the default kind is ${plain.lot.kind}`);
    const [, tagged] = await grant(user, 10, { kind: 'ad-reward_2' });
    if(tagged.lot.kind !== 'ad-reward_2') return fail(`got ${tagged.lot.kind}`);

    for(const kind of ['Paid', 'has space', ' ', 'x'.repeat(51), 'caf\u00e9', 5]){
      const [error] = await grant(user, 10, { kind });
      if(error?.code !== 400) return fail(`kind ${JSON.stringify(kind)} gave ${error?.code ?? 'success'}`);
    }

    const [, balance] = await getBalance({ userId: user });
    if(balance.byKind.general !== 10 || balance.byKind['ad-reward_2'] !== 10) return fail(`byKind is ${JSON.stringify(balance.byKind)}`);
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
    const [, promo] = await grant(user, 50, { kind: 'promo' });
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

  'a claw back takes from the user\'s other credits before anything is owed': async ({ pass, fail }) => {
    const user = freshUser();
    const [, first] = await grant(user, 100, { kind: 'paid' });
    const [, second] = await grant(user, 100, { kind: 'paid' });
    await spend(user, 150);

    const [error, result] = await clawBackGrant({ lotId: first.lot.id });
    if(error) return fail(error.msg);
    if(result.taken !== 50 || result.fromOtherCredits !== 50 || result.shortfall !== 50 || result.owed !== 50) {
      return fail(`took ${result.taken} (${result.fromOtherCredits} from other credits), short ${result.shortfall}, owed ${result.owed}`);
    }
    if(result.balance.total !== -50) return fail(`balance is ${result.balance.total}`);

    const fromSecond = await db.select().from(kempoCreditEntry).where(eq(kempoCreditEntry.lotId, second.lot.id));
    const taken = fromSecond.find(entry => entry.type === 'clawback');
    if(taken?.reversesOperationId !== first.operationId) return fail('the credits taken from the other lot do not say which grant they were taken back for');

    /*
      Both grants refunded: 150 was spent and none of it paid for, so 150 is owed. The second grant's
      own claim is still its whole 100 — what was taken from its lot was taken for the first.
    */
    const [, both] = await clawBackGrant({ lotId: second.lot.id });
    if(both.clawedBack !== 100 || both.owed !== 150) return fail(`second claw back took ${both.clawedBack}, owed ${both.owed}`);

    if(!await check(user, fail)) return;
    pass('');
  },

  'with enough other credits a claw back leaves nothing owed': async ({ pass, fail }) => {
    const user = freshUser();
    const [, bought] = await grant(user, 100, { kind: 'paid' });
    await spend(user, 70);
    await grant(user, 200);

    const [error, result] = await clawBackGrant({ lotId: bought.lot.id });
    if(error) return fail(error.msg);
    if(result.taken !== 100 || result.shortfall !== 0 || result.owed !== 0) return fail(`took ${result.taken}, short ${result.shortfall}, owed ${result.owed}`);
    if(result.balance.total !== 130) return fail(`balance is ${result.balance.total}, expected 300 - 70 - 100`);

    if(!await check(user, fail)) return;
    pass('');
  },

  'credits never expire: nothing can be granted with an expiry': async ({ pass, fail }) => {
    const user = freshUser();
    for(const extra of [{ expiresInDays: 1 }, { expiresAt: new Date(Date.now() + 1000) }, { kind: 'paid', expiresInDays: 365 }]){
      const [error] = await grant(user, 10, extra);
      if(error?.code !== 400 || !/do not expire/.test(error.msg)) return fail(`${JSON.stringify(extra)} gave ${JSON.stringify(error)}`);
    }
    if('expiresAt' in kempoCreditLot) return fail('the lot table has an expiry column again');
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
