import newId from '../ids.js';
import { fire } from './events.js';
import { balanceIn, findOperation, settle, writeOperation } from './lots.js';
import { abort, withUserLocks } from './transaction.js';
import { cleanKey, cleanText, cleanUserId } from './validate.js';

/*
  Gives back what a spend took, to the lots it took it from.

  ```js
  await reverseSpend({ userId, idempotencyKey: `boost:${event.id}` });  // the spend's own key
  ```

  Returning credits to the lot they came from keeps each kind of credit with its own history — a
  feature that fell through after being paid for with credits that were bought gives those back to
  the purchase they came from, so that purchase is again refundable by whatever sold them. A lot that
  went below zero after the spend — a refund that could not take everything back — has its debt
  reduced instead.

  This is also how an administrator puts right a spend on something the user never received.

  Reversing twice reverses once: the second call returns the first reversal with `duplicate: true`.
*/
export default async ({ userId, idempotencyKey, reason = null, actorId = null, note = null } = {}) => {
  const [userError, user] = cleanUserId(userId);
  if(userError) return [userError, null];
  const [keyError, key] = cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  const [reasonError, cleanReason] = cleanText(reason, 'A reason', { max: 100 });
  if(reasonError) return [reasonError, null];
  const [noteError, cleanNote] = cleanText(note, 'A note');
  if(noteError) return [noteError, null];

  const now = new Date();
  const reverseKey = `reverse:${key}`;

  const [error, result] = await withUserLocks([user], async tx => {
    const spend = await findOperation(tx, user, key);
    if(!spend) abort(404, 'No spend was made under that idempotency key');
    if(spend.first.type !== 'spend') abort(400, `That key belongs to a ${spend.first.type}, and only a spend can be reversed`);

    const reference = spend.first.referenceOwner ? { owner: spend.first.referenceOwner, ref: spend.first.referenceId } : null;
    const amount = -spend.entries.reduce((sum, entry) => sum + entry.amount, 0);

    const existing = await findOperation(tx, user, reverseKey);
    if(existing){
      return [null, {
        duplicate: true,
        operationId: existing.first.operationId,
        reversedOperationId: spend.first.operationId,
        amount,
        reference,
        entries: existing.entries,
        balance: await balanceIn(tx, user),
      }];
    }

    const operationId = newId('op');
    const entries = await writeOperation(tx, {
      userId: user,
      operationId,
      key: reverseKey,
      reason: cleanReason || spend.first.reason,
      reference,
      reversesOperationId: spend.first.operationId,
      actorId,
      note: cleanNote,
      now,
    }, spend.entries.map(entry => ({ lotId: entry.lotId, type: 'reversal', amount: -entry.amount })));

    await settle(tx, { userId: user, operationId, now: new Date(now.getTime() + 20), actorId });

    return [null, {
      duplicate: false,
      operationId,
      reversedOperationId: spend.first.operationId,
      amount,
      reference,
      entries,
      balance: await balanceIn(tx, user),
    }];
  }, { conflict: 'That spend was already reversed' });

  if(error) return [error, null];

  if(!result.duplicate){
    await fire('credits:reversed', {
      userId: user,
      operationId: result.operationId,
      reversedOperationId: result.reversedOperationId,
      amount: result.amount,
      reference: result.reference,
      balance: result.balance,
    });
  }

  return [null, result];
};
