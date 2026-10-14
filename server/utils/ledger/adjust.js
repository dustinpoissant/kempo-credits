import { readConfig } from '../config/settings.js';
import newId from '../ids.js';
import { crossedLow, fire } from './events.js';
import { balanceIn, expireDue, findOperation, owingLots, spendableLots, takeInOrder, writeOperation } from './lots.js';
import { abort, withUserLocks } from './transaction.js';
import { cleanAmount, cleanKey, cleanText, cleanUserId } from './validate.js';

/*
  The two corrections an administrator makes by hand. Both are ledger operations like any other —
  idempotent, recorded with who did it and why — and neither can do anything the ledger could not
  explain afterwards.

  Adding credits is not here: that is a grant (`grantCredits`, kind `promo`), and it gets a lot of its
  own with its own expiry, so it is spent and reported like every other grant.
*/

const prepare = ({ userId, amount, note, idempotencyKey }, { amountRequired }) => {
  const [userError, user] = cleanUserId(userId);
  if(userError) return [userError, null];
  if(amountRequired || (amount !== undefined && amount !== null)){
    const [amountError] = cleanAmount(amount);
    if(amountError) return [amountError, null];
  }
  const [noteError, cleanNote] = cleanText(note, 'A note', { required: true });
  if(noteError) return [{ code: 400, msg: 'Say why — the note is what explains this entry later' }, null];
  const [keyError, key] = cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  return [null, { user, note: cleanNote, key }];
};

const replay = async (tx, user, key, type, now, config) => {
  const existing = await findOperation(tx, user, key);
  if(!existing) return null;
  if(existing.first.type !== type) abort(409, `That idempotency key was already used for a ${existing.first.type}`);
  const amount = Math.abs(existing.entries.reduce((sum, entry) => sum + entry.amount, 0));
  const balance = await balanceIn(tx, user, now, config);
  return [null, { duplicate: true, operationId: existing.first.operationId, amount, entries: existing.entries, balance, before: balance }];
};

/*
  Takes credits away, in spending order, and never more than the user has.
*/
export const removeCredits = async ({ userId, amount, note, idempotencyKey, actorId = null } = {}) => {
  const [inputError, input] = prepare({ userId, amount, note, idempotencyKey }, { amountRequired: true });
  if(inputError) return [inputError, null];
  const { user, key } = input;

  const config = await readConfig();
  const now = new Date();

  const [error, result] = await withUserLocks([user], async tx => {
    const duplicate = await replay(tx, user, key, 'removal', now, config);
    if(duplicate) return duplicate;

    await expireDue(tx, user, now);
    const before = await balanceIn(tx, user, now, config);
    const moves = takeInOrder(await spendableLots(tx, user, now), amount, 'removal');
    if(!moves) abort(402, `They only have ${Math.max(before.total, 0)} credits to remove`, { balance: before.total, needed: amount });

    const operationId = newId('op');
    const entries = await writeOperation(tx, { userId: user, operationId, key, reason: 'adjustment', actorId, note: input.note, now }, moves);
    return [null, { duplicate: false, operationId, amount, entries, balance: await balanceIn(tx, user, now, config), before }];
  });

  if(error) return [error, null];

  const { before, ...removed } = result;
  if(!removed.duplicate && crossedLow(before, removed.balance, config.lowBalanceThreshold)){
    await fire('credits:low', { userId: user, balance: removed.balance, threshold: config.lowBalanceThreshold });
  }
  return [null, removed];
};

/*
  Writes off what a user owes, oldest debt first — all of it, or `amount` of it. A business decision
  (a goodwill gesture, a refund made in error) that the ledger records but cannot make for anyone.
*/
export const forgiveDebt = async ({ userId, amount, note, idempotencyKey, actorId = null } = {}) => {
  const [inputError, input] = prepare({ userId, amount, note, idempotencyKey }, { amountRequired: false });
  if(inputError) return [inputError, null];
  const { user, key } = input;

  const config = await readConfig();
  const now = new Date();

  const [error, result] = await withUserLocks([user], async tx => {
    const duplicate = await replay(tx, user, key, 'forgiveness', now, config);
    if(duplicate) return duplicate;

    const owing = await owingLots(tx, user);
    const owed = owing.reduce((sum, lot) => sum - lot.remaining, 0);
    if(!owed) abort(409, 'They do not owe anything');
    if(amount && amount > owed) abort(400, `They only owe ${owed}`);

    let left = amount || owed;
    const moves = [];
    for(const lot of owing){
      if(left <= 0) break;
      const give = Math.min(-lot.remaining, left);
      moves.push({ lotId: lot.id, type: 'forgiveness', amount: give });
      left -= give;
    }

    const operationId = newId('op');
    const entries = await writeOperation(tx, { userId: user, operationId, key, reason: 'adjustment', actorId, note: input.note, now }, moves);
    const balance = await balanceIn(tx, user, now, config);
    return [null, { duplicate: false, operationId, amount: amount || owed, entries, balance, before: balance }];
  });

  if(error) return [error, null];

  const { before, ...forgiven } = result;
  return [null, forgiven];
};
