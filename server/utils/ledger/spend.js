import { readConfig } from '../config/settings.js';
import newId from '../ids.js';
import { crossedLow, fire } from './events.js';
import { balanceIn, findOperation, spendableLots, takeInOrder, writeOperation } from './lots.js';
import { abort, withUserLocks } from './transaction.js';
import { cleanAmount, cleanKey, cleanReference, cleanText, cleanUserId } from './validate.js';

/*
  Uses credits on something.

  ```js
  const [error, spent] = await spendCredits({
    userId,
    amount: 300,
    reason: 'boost',
    reference: { owner: 'crowd-pulse', ref: event.id },   // what was bought, in your terms
    idempotencyKey: `boost:${event.id}`,
  });
  if(error?.code === 402) // not enough — error.balance and error.needed say by how much
  ```

  All or nothing: either every credit is taken or none is, and a balance never goes below zero.
  A user who owes credits from a refunded purchase cannot spend at all until that is paid off.

  Spending twice under one key spends once and returns the first spend (`duplicate: true`), so a
  feature can retry freely. Keep the key — `reverseSpend` takes it to give the credits back.

  Credits come out of promo lots before paid ones, oldest first, and the entries record which lots
  they came out of.
*/
export default async ({ userId, amount, reason, reference, idempotencyKey, actorId = null, note = null } = {}) => {
  const [userError, user] = cleanUserId(userId);
  if(userError) return [userError, null];
  const [amountError] = cleanAmount(amount);
  if(amountError) return [amountError, null];
  const [reasonError, cleanReason] = cleanText(reason, 'A reason', { required: true, max: 100 });
  if(reasonError) return [reasonError, null];
  const [referenceError, cleanRef] = cleanReference(reference, { required: true });
  if(referenceError) return [referenceError, null];
  const [keyError, key] = cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  const [noteError, cleanNote] = cleanText(note, 'A note');
  if(noteError) return [noteError, null];

  const config = await readConfig();
  const now = new Date();

  const [error, result] = await withUserLocks([user], async tx => {
    const existing = await findOperation(tx, user, key);
    if(existing){
      const { first, entries } = existing;
      if(first.type !== 'spend') abort(409, `That idempotency key was already used for a ${first.type}, not a spend`);
      const spent = -entries.reduce((sum, entry) => sum + entry.amount, 0);
      if(spent !== amount) abort(409, `That idempotency key was already used for a spend of ${spent}`);

      const balance = await balanceIn(tx, user);
      return [null, { duplicate: true, operationId: first.operationId, amount, entries, balance, before: balance }];
    }

    const before = await balanceIn(tx, user);

    if(before.owed > 0){
      abort(402, `This account owes ${before.owed} credits from a refunded purchase, and cannot spend until that is paid off`, {
        balance: before.total, owed: before.owed, needed: amount,
      });
    }

    const moves = takeInOrder(await spendableLots(tx, user), amount, 'spend');
    if(!moves){
      abort(402, `Not enough credits: this needs ${amount} and the balance is ${before.total}`, { balance: before.total, needed: amount });
    }

    const operationId = newId('op');
    const entries = await writeOperation(tx, {
      userId: user, operationId, key, reason: cleanReason, reference: cleanRef, actorId, note: cleanNote, now,
    }, moves);

    return [null, { duplicate: false, operationId, amount, entries, balance: await balanceIn(tx, user), before }];
  }, { conflict: 'That idempotency key was already used' });

  if(error) return [error, null];

  const { before, ...spent } = result;

  if(!spent.duplicate){
    await fire('credits:spent', {
      userId: user, operationId: spent.operationId, amount, reason: cleanReason, reference: cleanRef, entries: spent.entries, balance: spent.balance,
    });
    if(crossedLow(before, spent.balance, config.lowBalanceThreshold)){
      await fire('credits:low', { userId: user, balance: spent.balance, threshold: config.lowBalanceThreshold });
    }
  }

  return [null, spent];
};
