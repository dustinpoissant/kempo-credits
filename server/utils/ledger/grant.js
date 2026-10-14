import { eq } from 'drizzle-orm';
import { kempoCreditLot } from '../../db/schema.js';
import newId from '../ids.js';
import { fire } from './events.js';
import { balanceIn, findOperation, settle, writeOperation } from './lots.js';
import { abort, withUserLocks } from './transaction.js';
import { cleanAmount, cleanKey, cleanKind, cleanReference, cleanText, cleanUserId } from './validate.js';

/*
  Creates a lot and the entry that fills it.

  ```js
  const [error, { lot, balance }] = await grantCredits({
    userId,
    amount: 500,
    kind: 'promo',                      // or 'paid'
    reason: 'award',
    reference: { owner: 'my-extension', ref: competition.id },
    idempotencyKey: `award:${competition.id}:${userId}`,
  });
  ```

  Granting twice under the same key returns the first grant (`duplicate: true`) instead of making a
  second. That is what lets a webhook that is delivered twice, or a monthly allowance whose job runs
  twice, give the credits once: a monthly grant is `idempotencyKey: \`monthly:${userId}:2026-10\``.

  **Credits never expire**, paid or promo. A caller that passes an expiry is refused rather than
  ignored, so code written expecting one finds out at once.

  If the user owes credits — a refunded purchase they had already spent — the grant pays that off
  first, and `settled` says how much of it did. Their balance is what is left.
*/
export default async ({ userId, amount, kind, expiresAt, expiresInDays, reason, reference, idempotencyKey, actorId = null, note = null } = {}) => {
  if((expiresAt !== undefined && expiresAt !== null) || (expiresInDays !== undefined && expiresInDays !== null)){
    return [{ code: 400, msg: 'Credits do not expire, so a grant cannot have an expiry' }, null];
  }

  const [userError, user] = cleanUserId(userId);
  if(userError) return [userError, null];
  const [amountError] = cleanAmount(amount);
  if(amountError) return [amountError, null];
  const [kindError] = cleanKind(kind);
  if(kindError) return [kindError, null];
  const [reasonError, cleanReason] = cleanText(reason, 'A reason', { required: true, max: 100 });
  if(reasonError) return [reasonError, null];
  const [referenceError, cleanRef] = cleanReference(reference);
  if(referenceError) return [referenceError, null];
  const [keyError, key] = cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  const [noteError, cleanNote] = cleanText(note, 'A note');
  if(noteError) return [noteError, null];

  const now = new Date();

  const [error, result] = await withUserLocks([user], async tx => {
    const existing = await findOperation(tx, user, key);
    if(existing){
      const { first, entries } = existing;
      if(first.type !== 'grant') abort(409, `That idempotency key was already used for a ${first.type}, not a grant`);
      if(first.amount !== amount) abort(409, `That idempotency key was already used for a grant of ${first.amount}`);

      const [lot] = await tx.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, first.lotId));
      return [null, {
        duplicate: true,
        operationId: first.operationId,
        lot,
        amount,
        kind: lot.kind,
        settled: entries.filter(entry => entry.type === 'settlement' && entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0),
        entries,
        balance: await balanceIn(tx, user),
      }];
    }

    const operationId = newId('op');
    const lot = {
      id: newId('lot'),
      userId: user,
      kind,
      amount,
      remaining: 0,
      reason: cleanReason,
      referenceOwner: cleanRef?.owner ?? null,
      referenceId: cleanRef?.ref ?? null,
      operationId,
      actorId,
      note: cleanNote,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(kempoCreditLot).values(lot);

    const granted = await writeOperation(tx, {
      userId: user, operationId, key, reason: cleanReason, reference: cleanRef, actorId, note: cleanNote, now,
    }, [{ lotId: lot.id, type: 'grant', amount }]);

    const settlement = await settle(tx, { userId: user, operationId, now: new Date(now.getTime() + 1), actorId });

    const [fresh] = await tx.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, lot.id));

    return [null, {
      duplicate: false,
      operationId,
      lot: fresh,
      amount,
      kind,
      settled: settlement.filter(entry => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0),
      entries: [...granted, ...settlement],
      balance: await balanceIn(tx, user),
    }];
  }, { conflict: 'That idempotency key was already used' });

  if(error) return [error, null];

  if(!result.duplicate){
    await fire('credits:granted', {
      userId: user,
      operationId: result.operationId,
      lot: result.lot,
      amount,
      kind,
      reason: cleanReason,
      reference: cleanRef,
      settled: result.settled,
      balance: result.balance,
    });
  }

  return [null, result];
};
