import { kempoCreditLot } from '../../db/schema.js';
import { kindList, readConfig } from '../config/settings.js';
import newId from '../ids.js';
import { crossedLow, fire } from './events.js';
import { balanceIn, findOperation, settle, spendableLots, takeInOrder, writeOperation } from './lots.js';
import { abort, withUserLocks } from './transaction.js';
import { cleanAmount, cleanKey, cleanReference, cleanText, cleanUserId } from './validate.js';

/*
  Moves credits from one user to another, as one operation.

  ```js
  const [error, sent] = await transferCredits({
    fromUserId: seller.id,
    toUserId: buyer.id,
    amount: 250,
    reason: 'trade',                                        // 'gift', 'trade', 'payment'…
    reference: { owner: 'my-game', ref: `trade:${trade.id}` },
    idempotencyKey: `trade:${trade.id}`,
  });
  if(error?.code === 402) // the sender does not hold that many; error.balance and error.transferable say what they do
  ```

  This is what a game needs for trading items for credits, or what a site needs for gifting. A trade
  of an item for credits is the item changing hands and this call under one id — keep the item's own
  move and this under the same key, and a retry of both is safe.

  All or nothing, and both users are locked for it, so the credits cannot be sent twice and cannot
  be spent in between. The recipient gets one new lot per kind of credit that was sent, with the same
  kind, so a lot's kind survives a gift. If the recipient owes credits, what they receive pays that
  off first (`settled`).

  What stops a transfer:
  - the sender owes credits (402), or does not hold enough *transferable* credits (402). Kinds listed
    in the `non_transferable_kinds` setting are never taken, but can still be spent;
  - sending to yourself (400).

  Sending twice under one key sends once and returns the first transfer (`duplicate: true`). The key
  is the sender's: it is filed under them, so two senders may use the same string.

  Like the rest of the SDK this is a data operation with no permission check, and it does **not**
  check that the recipient exists — a typo'd id would otherwise receive credits nobody can reach. The
  HTTP route that lets users send credits does that check; code calling this directly should too
  (`getUserById` from kempo's SDK).
*/
export default async ({ fromUserId, toUserId, amount, reason, reference, idempotencyKey, actorId = null, note = null } = {}) => {
  const [fromError, from] = cleanUserId(fromUserId);
  if(fromError) return [fromError, null];
  const [toError, to] = cleanUserId(toUserId);
  if(toError) return [toError, null];
  if(from === to) return [{ code: 400, msg: 'Credits cannot be sent to yourself' }, null];
  const [amountError] = cleanAmount(amount);
  if(amountError) return [amountError, null];
  const [reasonError, cleanReason] = cleanText(reason, 'A reason', { required: true, max: 100 });
  if(reasonError) return [reasonError, null];
  const [referenceError, cleanRef] = cleanReference(reference);
  if(referenceError) return [referenceError, null];
  const [keyError, key] = cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  const [noteError, cleanNote] = cleanText(note, 'A note');
  if(noteError) return [noteError, null];

  const config = await readConfig();
  const excludeKinds = kindList(config.nonTransferableKinds);
  const now = new Date();

  const [error, result] = await withUserLocks([from, to], async tx => {
    const existing = await findOperation(tx, from, key);
    if(existing){
      const { first, entries } = existing;
      if(first.type !== 'transfer_out') abort(409, `That idempotency key was already used for a ${first.type}, not a transfer`);
      const sent = -entries.filter(entry => entry.userId === from && entry.type === 'transfer_out').reduce((sum, entry) => sum + entry.amount, 0);
      if(sent !== amount || first.counterpartyId !== to) abort(409, 'That idempotency key was already used for a different transfer');

      return [null, {
        duplicate: true,
        operationId: first.operationId,
        amount,
        fromUserId: from,
        toUserId: to,
        settled: 0,
        entries,
        fromBalance: await balanceIn(tx, from),
        toBalance: await balanceIn(tx, to),
        before: await balanceIn(tx, from),
      }];
    }

    const before = await balanceIn(tx, from);
    if(before.owed > 0){
      abort(402, `This account owes ${before.owed} credits, and cannot send any until that is paid off`, {
        balance: before.total, owed: before.owed, needed: amount,
      });
    }

    const sources = await spendableLots(tx, from, { excludeKinds });
    const moves = takeInOrder(sources, amount, 'transfer_out');
    if(!moves){
      const transferable = sources.reduce((sum, lot) => sum + lot.remaining, 0);
      abort(402, transferable === before.total
        ? `Not enough credits: this needs ${amount} and the balance is ${before.total}`
        : `Not enough credits that can be sent: this needs ${amount} and ${transferable} of the ${before.total} can be transferred`,
      { balance: before.total, transferable, needed: amount });
    }

    const operationId = newId('op');

    // One lot for the recipient per kind sent, so a kind is the same on both sides.
    const perKind = new Map();
    for(const move of moves) perKind.set(move.kind, (perKind.get(move.kind) || 0) - move.amount);

    const received = [];
    for(const [kind, total] of perKind){
      const lot = {
        id: newId('lot'),
        userId: to,
        kind,
        amount: total,
        remaining: 0,
        reason: 'transfer',
        referenceOwner: cleanRef?.owner ?? null,
        referenceId: cleanRef?.ref ?? null,
        operationId,
        actorId,
        note: cleanNote,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(kempoCreditLot).values(lot);
      received.push({ lotId: lot.id, type: 'transfer_in', amount: total });
    }

    const sentEntries = await writeOperation(tx, {
      userId: from, operationId, key, reason: cleanReason, reference: cleanRef, counterpartyId: to, actorId, note: cleanNote, now,
    }, moves);
    const receivedEntries = await writeOperation(tx, {
      userId: to, operationId, reason: cleanReason, reference: cleanRef, counterpartyId: from, actorId, note: cleanNote, now: new Date(now.getTime() + 50),
    }, received);
    const settlement = await settle(tx, { userId: to, operationId, now: new Date(now.getTime() + 100), actorId });

    return [null, {
      duplicate: false,
      operationId,
      amount,
      fromUserId: from,
      toUserId: to,
      settled: settlement.filter(entry => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0),
      entries: [...sentEntries, ...receivedEntries, ...settlement],
      fromBalance: await balanceIn(tx, from),
      toBalance: await balanceIn(tx, to),
      before,
    }];
  }, { conflict: 'That idempotency key was already used' });

  if(error) return [error, null];

  const { before, ...sent } = result;

  if(!sent.duplicate){
    await fire('credits:transferred', {
      fromUserId: from,
      toUserId: to,
      operationId: sent.operationId,
      amount,
      reason: cleanReason,
      reference: cleanRef,
      settled: sent.settled,
      fromBalance: sent.fromBalance,
      toBalance: sent.toBalance,
    });

    if(crossedLow(before, sent.fromBalance, config.lowBalanceThreshold)){
      await fire('credits:low', { userId: from, balance: sent.fromBalance, threshold: config.lowBalanceThreshold });
    }
  }

  return [null, sent];
};
