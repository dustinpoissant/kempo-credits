import { and, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoCreditEntry, kempoCreditLot } from '../../db/schema.js';
import { readConfig } from '../config/settings.js';
import newId from '../ids.js';
import { crossedLow, fire, notifyAdmins } from './events.js';
import { balanceIn, expireDue, findOperation, settle, writeOperation } from './lots.js';
import { abort, withUserLocks } from './transaction.js';
import { cleanAmount, cleanKey, cleanReference, cleanText } from './validate.js';

/*
  Takes back a grant — what a refund of the purchase behind it does.

  ```js
  const [error, result] = await clawBackGrant({ reference: { owner: 'kempo-credits', ref: purchase.id } });
  // or { lotId }, and optionally `amount` to take back only part of it
  ```

  Whatever is left in the lot is taken. Whatever was already **spent** cannot be, and that is the
  shortfall: it is recorded as a `shortfall` entry that takes the lot below zero, so the user's
  balance shows what they owe. It is paid off straight away from any other credits they hold
  (`settled`), and anything still owed after that (`owed`) blocks them from spending until credits
  they are granted later — a purchase, a promo — have covered it, or an administrator writes it off.
  Without that, buying, spending and then refunding would be a way to keep what was spent for free.

  A shortfall is never silent: it fires `credits:clawed-back` with the figures, and every person who
  can see credits is notified.

  Credits of the grant that expired, or that an administrator removed, were never used by anybody
  and are not counted against the user. Taking back more than is left to take back is limited to
  what is, and a grant with nothing left to take back is a 409.
*/

const sumOf = (entries, types) => -entries.filter(entry => types.includes(entry.type)).reduce((sum, entry) => sum + entry.amount, 0);

const findLot = async ({ lotId, reference }) => {
  try {
    if(lotId){
      const [lot] = await db.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, lotId)).limit(1);
      return lot ? [null, lot] : [{ code: 404, msg: 'No such lot' }, null];
    }

    const lots = await db.select().from(kempoCreditLot)
      .where(and(eq(kempoCreditLot.referenceOwner, reference.owner), eq(kempoCreditLot.referenceId, reference.ref)))
      .limit(2);
    if(!lots.length) return [{ code: 404, msg: 'No grant has that reference' }, null];
    if(lots.length > 1) return [{ code: 409, msg: 'More than one grant has that reference — claw back by lot id instead' }, null];
    return [null, lots[0]];
  } catch {
    return [{ code: 500, msg: 'Could not load the lot' }, null];
  }
};

export default async ({ lotId, reference, amount, reason = 'clawback', idempotencyKey, actorId = null, note = null } = {}) => {
  if(!lotId && !reference) return [{ code: 400, msg: 'Say which grant to claw back: a lotId or its reference' }, null];
  if(lotId && typeof lotId !== 'string') return [{ code: 400, msg: 'That is not a lot id' }, null];

  const [referenceError, cleanRef] = cleanReference(lotId ? null : reference);
  if(referenceError) return [referenceError, null];
  if(amount !== undefined && amount !== null){
    const [amountError] = cleanAmount(amount);
    if(amountError) return [amountError, null];
  }
  const [keyError, key] = idempotencyKey === undefined || idempotencyKey === null ? [null, null] : cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  const [reasonError, cleanReason] = cleanText(reason, 'A reason', { max: 100 });
  if(reasonError) return [reasonError, null];
  const [noteError, cleanNote] = cleanText(note, 'A note');
  if(noteError) return [noteError, null];

  const [lotError, found] = await findLot({ lotId, reference: cleanRef });
  if(lotError) return [lotError, null];

  const config = await readConfig();
  const now = new Date();
  const userId = found.userId;

  const [error, result] = await withUserLocks([userId], async tx => {
    if(key){
      const existing = await findOperation(tx, userId, key);
      if(existing){
        const { first, entries } = existing;
        if(!['clawback', 'shortfall'].includes(first.type)) abort(409, `That idempotency key was already used for a ${first.type}, not a claw back`);
        const [lot] = await tx.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, first.lotId));
        const balance = await balanceIn(tx, userId, now, config);
        const taken = sumOf(entries, ['clawback']);
        const shortfall = sumOf(entries, ['shortfall']);
        return [null, {
          duplicate: true,
          operationId: first.operationId,
          lot,
          clawedBack: taken + shortfall,
          taken,
          shortfall,
          settled: entries.filter(entry => entry.type === 'settlement' && entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0),
          owed: balance.owed,
          balance,
          before: balance,
        }];
      }
    }

    await expireDue(tx, userId, now);

    const [lot] = await tx.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, found.id));
    const history = await tx.select().from(kempoCreditEntry).where(eq(kempoCreditEntry.lotId, lot.id));

    const claimable = lot.amount - sumOf(history, ['clawback', 'shortfall', 'expiry', 'removal']);
    if(claimable <= 0) abort(409, 'Nothing is left of this grant to claw back');

    const wanted = amount ? Math.min(amount, claimable) : claimable;
    const taken = Math.min(Math.max(lot.remaining, 0), wanted);
    const shortfall = wanted - taken;

    const before = await balanceIn(tx, userId, now, config);
    const operationId = newId('op');
    const reference = lot.referenceOwner ? { owner: lot.referenceOwner, ref: lot.referenceId } : null;

    await writeOperation(tx, {
      userId, operationId, key, reason: cleanReason, reference, actorId, note: cleanNote, now,
    }, [
      { lotId: lot.id, type: 'clawback', amount: -taken },
      { lotId: lot.id, type: 'shortfall', amount: -shortfall },
    ]);

    const settlement = shortfall ? await settle(tx, { userId, operationId, now: new Date(now.getTime() + 10), actorId }) : [];
    const [after] = await tx.select().from(kempoCreditLot).where(eq(kempoCreditLot.id, lot.id));
    const balance = await balanceIn(tx, userId, now, config);

    return [null, {
      duplicate: false,
      operationId,
      lot: after,
      clawedBack: wanted,
      taken,
      shortfall,
      settled: settlement.filter(entry => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0),
      owed: balance.owed,
      balance,
      before,
    }];
  }, { conflict: 'That claw back was already done' });

  if(error) return [error, null];

  const { before, ...clawed } = result;

  if(!clawed.duplicate){
    await fire('credits:clawed-back', {
      userId,
      operationId: clawed.operationId,
      lot: clawed.lot,
      taken: clawed.taken,
      shortfall: clawed.shortfall,
      settled: clawed.settled,
      owed: clawed.owed,
      balance: clawed.balance,
    });

    if(clawed.shortfall){
      await notifyAdmins({
        title: clawed.owed ? 'A user owes credits after a refund' : 'A refund took back credits that were already spent',
        message: clawed.owed
          ? `${clawed.shortfall} of the credits taken back had already been spent. ${clawed.settled} came out of their other credits and they still owe ${clawed.owed}, so they cannot spend until that is covered or written off.`
          : `${clawed.shortfall} of the credits taken back had already been spent, and were taken from the user's other credits instead.`,
        dedupeKey: `shortfall:${userId}`,
        url: `/admin/extension/kempo-credits/?user=${encodeURIComponent(userId)}`,
      });
    }

    if(crossedLow(before, clawed.balance, config.lowBalanceThreshold)){
      await fire('credits:low', { userId, balance: clawed.balance, threshold: config.lowBalanceThreshold });
    }
  }

  return [null, clawed];
};
