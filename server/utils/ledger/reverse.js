import { readConfig } from '../config/settings.js';
import newId from '../ids.js';
import { fire } from './events.js';
import { balanceIn, expireDue, findOperation, settle, writeOperation } from './lots.js';
import { abort, withUserLocks } from './transaction.js';
import { cleanKey, cleanText, cleanUserId } from './validate.js';

/*
  Gives back what a spend took, to the lots it took it from.

  ```js
  await reverseSpend({ userId, idempotencyKey: `boost:${event.id}` });  // the spend's own key
  ```

  Returning credits to the lot they came from is what keeps promo and paid apart — a refunded
  feature bought with promo credits gives promo credits back, with the same expiry they had. A lot
  that has expired since gets its credits back and loses them again straight away (`expired` says how
  many), because they would have expired unspent too. A lot that went below zero after the spend — a
  refund clawed back — has its debt reduced instead.

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

  const config = await readConfig();
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
        expired: 0,
        balance: await balanceIn(tx, user, now, config),
      }];
    }

    await expireDue(tx, user, now);

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

    const expired = await expireDue(tx, user, new Date(now.getTime() + 10));
    await settle(tx, { userId: user, operationId, now: new Date(now.getTime() + 20), actorId });

    return [null, {
      duplicate: false,
      operationId,
      reversedOperationId: spend.first.operationId,
      amount,
      reference,
      entries,
      expired: -expired.reduce((sum, entry) => sum + entry.amount, 0),
      balance: await balanceIn(tx, user, now, config),
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
