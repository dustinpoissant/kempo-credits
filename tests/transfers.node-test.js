import { eq } from 'drizzle-orm';
import { kempoCreditEntry, kempoCreditLot } from '../server/db/schema.js';
import grantCredits from '../server/utils/ledger/grant.js';
import spendCredits from '../server/utils/ledger/spend.js';
import transferCredits from '../server/utils/ledger/transfer.js';
import { clawBackGrant } from '../server/utils/ledger/clawback.js';
import { getBalance, getOperation, listEntries } from '../server/utils/ledger/read.js';
import { db } from './helpers/db.js';
import { freshUser, heard, invariant, key, listenToHooks, purge, stopListening, withSetting } from './helpers/ledger.js';

/*
  Moving credits from one user to another: what it writes on both sides, what stops it, and that the
  two ledgers still add up afterwards. Concurrency is in concurrency.node-test.js.
*/

const grant = (userId, amount, extra = {}) => grantCredits({
  userId, amount, reason: 'test', idempotencyKey: key(), ...extra,
});

const send = (fromUserId, toUserId, amount, extra = {}) => transferCredits({
  fromUserId, toUserId, amount, reason: 'gift', idempotencyKey: key(), ...extra,
});

const bothHold = async (fail, ...users) => {
  for(const user of users){
    const problem = await invariant(user);
    if(problem){
      fail(`invariant broken for ${user}: ${problem}`);
      return false;
    }
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
  'a transfer moves credits, writes both ledgers, and both still add up': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 100);

    const [error, sent] = await send(alice, bob, 40, { reference: { owner: 'test', ref: 'gift-1' }, note: 'happy birthday', actorId: alice });
    if(error) return fail(error.msg);
    if(sent.fromBalance.total !== 60 || sent.toBalance.total !== 40) return fail(`balances ${sent.fromBalance.total} and ${sent.toBalance.total}`);

    const [, out] = await listEntries({ userId: alice, type: 'transfer_out' });
    const [, received] = await listEntries({ userId: bob, type: 'transfer_in' });
    if(out.total !== 1 || out.entries[0].amount !== -40 || out.entries[0].counterpartyId !== bob) return fail(`sender entry: ${JSON.stringify(out.entries[0])}`);
    if(received.total !== 1 || received.entries[0].amount !== 40 || received.entries[0].counterpartyId !== alice) return fail(`recipient entry: ${JSON.stringify(received.entries[0])}`);
    if(out.entries[0].operationId !== received.entries[0].operationId) return fail('the two sides are not one operation');
    if(received.entries[0].referenceId !== 'gift-1' || received.entries[0].note !== 'happy birthday') return fail('reference and note were not carried to the recipient');

    const [, operation] = await getOperation({ operationId: sent.operationId });
    if(operation.type !== 'transfer_out' || operation.amount !== -40) return fail(`operation is ${operation.type} ${operation.amount}`);

    if(!await bothHold(fail, alice, bob)) return;
    pass('');
  },

  'a lot keeps its kind across a transfer, one lot per kind sent': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 30, { kind: 'achievement' });
    await grant(alice, 50, { kind: 'purchase' });

    const [error] = await send(alice, bob, 60);
    if(error) return fail(error.msg);

    const [, balance] = await getBalance({ userId: bob });
    if(balance.byKind.achievement !== 30 || balance.byKind.purchase !== 30) return fail(`bob has ${JSON.stringify(balance.byKind)}`);
    const lots = await db.select().from(kempoCreditLot).where(eq(kempoCreditLot.userId, bob));
    if(lots.length !== 2) return fail(`${lots.length} lots`);

    const [, mine] = await getBalance({ userId: alice });
    if(mine.total !== 20 || mine.byKind.purchase !== 20) return fail(`alice has ${JSON.stringify(mine.byKind)}`);
    if(!await bothHold(fail, alice, bob)) return;
    pass('');
  },

  'what is not there cannot be sent, and nothing moves': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 50);

    const [error] = await send(alice, bob, 51);
    if(error?.code !== 402 || error.balance !== 50 || error.needed !== 51) return fail(JSON.stringify(error));

    const [, a] = await getBalance({ userId: alice });
    const [, b] = await getBalance({ userId: bob });
    if(a.total !== 50 || b.total !== 0) return fail(`alice ${a.total}, bob ${b.total}`);
    const entries = await db.select().from(kempoCreditEntry).where(eq(kempoCreditEntry.userId, bob));
    if(entries.length) return fail('a refused transfer wrote entries for the recipient');
    pass('');
  },

  'a transfer refuses what it cannot record honestly': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 100);

    const cases = [
      [{ toUserId: alice }, 400, 'sending to yourself'],
      [{ amount: 0 }, 400, 'zero'],
      [{ amount: 1.5 }, 400, 'a fraction'],
      [{ amount: -5 }, 400, 'a negative amount'],
      [{ amount: '5' }, 400, 'an amount as text'],
      [{ reason: '' }, 400, 'no reason'],
      [{ idempotencyKey: '' }, 400, 'no key'],
      [{ toUserId: '' }, 400, 'no recipient'],
      [{ reference: { owner: 'x' } }, 400, 'half a reference'],
    ];
    for(const [overrides, code, label] of cases){
      const [error] = await transferCredits({ fromUserId: alice, toUserId: bob, amount: 5, reason: 'gift', idempotencyKey: key(), ...overrides });
      if(error?.code !== code) return fail(`${label}: expected ${code}, got ${error ? error.code : 'success'}`);
    }

    const [, balance] = await getBalance({ userId: alice });
    if(balance.total !== 100) return fail(`a refused transfer took credits: ${balance.total}`);
    pass(`${cases.length} refusals`);
  },

  'the same transfer sent twice is sent once': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 100);
    const idempotencyKey = key();
    globalThis.kempoCreditsHooks = [];

    const [, first] = await send(alice, bob, 30, { idempotencyKey });
    const [error, second] = await send(alice, bob, 30, { idempotencyKey });
    if(error) return fail(error.msg);
    if(first.duplicate || !second.duplicate) return fail('the retry was not recognised');
    if(second.operationId !== first.operationId) return fail('the retry made a second operation');
    if(second.fromBalance.total !== 70 || second.toBalance.total !== 30) return fail(`balances ${second.fromBalance.total}, ${second.toBalance.total}`);
    if(heard('credits:transferred').length !== 1) return fail(`credits:transferred fired ${heard('credits:transferred').length} times`);

    const [differentAmount] = await send(alice, bob, 31, { idempotencyKey });
    if(differentAmount?.code !== 409) return fail('the same key for a different amount was not refused');
    const [differentPerson] = await send(alice, freshUser(), 30, { idempotencyKey });
    if(differentPerson?.code !== 409) return fail('the same key for a different recipient was not refused');
    const [spendKey] = await spendCredits({ userId: alice, amount: 1, reason: 'x', reference: { owner: 't', ref: 'r' }, idempotencyKey });
    if(spendKey?.code !== 409) return fail('a transfer key reused for a spend was not refused');

    if(!await bothHold(fail, alice, bob)) return;
    pass('');
  },

  'the hook says who sent what to whom, once': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 100);
    globalThis.kempoCreditsHooks = [];

    await send(alice, bob, 25, { reason: 'trade', reference: { owner: 'my-game', ref: 'trade-7' } });

    const [event] = heard('credits:transferred');
    if(!event) return fail('credits:transferred did not fire');
    const { fromUserId, toUserId, amount, reason, reference, fromBalance, toBalance } = event.data;
    if(fromUserId !== alice || toUserId !== bob || amount !== 25 || reason !== 'trade') return fail(JSON.stringify(event.data));
    if(reference?.ref !== 'trade-7' || fromBalance.total !== 75 || toBalance.total !== 25) return fail(JSON.stringify(event.data));
    if(heard('credits:granted').some(call => call.data.userId === bob)) return fail('a transfer fired credits:granted for the recipient');
    pass('');
  },

  'credits:low fires for the sender when a transfer takes them below the threshold': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 100);

    await withSetting('low_balance_threshold', 50, 'number', async () => {
      globalThis.kempoCreditsHooks = [];
      await send(alice, bob, 70);
    });

    const low = heard('credits:low', alice);
    if(low.length !== 1 || low[0].data.balance.total !== 30) return fail(`fired ${low.length} times: ${JSON.stringify(low[0]?.data)}`);
    if(heard('credits:low', bob).length) return fail('the recipient got a low-balance event');
    pass('');
  },

  'kinds the site marks non-transferable are never sent, but can still be spent': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    await grant(alice, 100, { kind: 'purchase' });
    await grant(alice, 40, { kind: 'achievement' });

    await withSetting('non_transferable_kinds', 'purchase', 'string', async () => {
      const [tooMuch] = await send(alice, bob, 41);
      if(tooMuch?.code !== 402 || tooMuch.transferable !== 40 || tooMuch.balance !== 140) return fail(`asking for 41: ${JSON.stringify(tooMuch)}`);
      if(!/can be transferred/.test(tooMuch.msg)) return fail(`the message does not say why: ${tooMuch.msg}`);

      const [error, sent] = await send(alice, bob, 40);
      if(error) return fail(error.msg);
      if(sent.fromBalance.byKind.purchase !== 100 || sent.toBalance.byKind.achievement !== 40) return fail(`${JSON.stringify(sent.fromBalance.byKind)} / ${JSON.stringify(sent.toBalance.byKind)}`);

      const [spendError] = await spendCredits({ userId: alice, amount: 100, reason: 'item', reference: { owner: 't', ref: 'r' }, idempotencyKey: key() });
      if(spendError) return fail(`non-transferable credits could not be spent: ${spendError.msg}`);
    });

    if(!await bothHold(fail, alice, bob)) return;
    pass('');
  },

  'a user who owes credits cannot send any; a recipient who owes is paid off first': async ({ pass, fail }) => {
    const [alice, bob, carol] = [freshUser(), freshUser(), freshUser()];

    // Alice is owed-down by a refund she had already spent.
    const [, bought] = await grant(alice, 100, { kind: 'purchase' });
    await spendCredits({ userId: alice, amount: 100, reason: 'item', reference: { owner: 't', ref: 'r' }, idempotencyKey: key() });
    await clawBackGrant({ lotId: bought.lot.id });

    const [blocked] = await send(alice, bob, 1);
    if(blocked?.code !== 402 || blocked.owed !== 100) return fail(`an account that owes could send: ${JSON.stringify(blocked)}`);

    // A gift to her goes to the debt first.
    await grant(carol, 70);
    const [error, gift] = await send(carol, alice, 70);
    if(error) return fail(error.msg);
    if(gift.settled !== 70 || gift.toBalance.total !== -30 || gift.toBalance.owed !== 30) return fail(`settled ${gift.settled}, balance ${JSON.stringify(gift.toBalance)}`);

    if(!await bothHold(fail, alice, carol)) return;
    pass('');
  },

  'a transferred grant can still be clawed back, from whoever now holds it': async ({ pass, fail }) => {
    const [alice, bob] = [freshUser(), freshUser()];
    const [, granted] = await grant(alice, 100, { kind: 'purchase' });
    await send(alice, bob, 100);

    const [error, result] = await clawBackGrant({ lotId: granted.lot.id });
    // The original lot was emptied by the transfer, so everything is "short" against alice, who has nothing.
    if(error) return fail(error.msg);
    if(result.taken !== 0 || result.shortfall !== 100 || result.owed !== 100) return fail(`took ${result.taken}, short ${result.shortfall}, owed ${result.owed}`);

    const [, bobBalance] = await getBalance({ userId: bob });
    if(bobBalance.total !== 100) return fail('the recipient lost credits to a claw back of the sender\'s grant');
    if(!await bothHold(fail, alice, bob)) return;
    pass('');
  },
};
