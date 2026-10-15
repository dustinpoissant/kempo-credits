import { triggerHook, createNotification } from 'kempo/server/sdk.js';
import { OWNER } from '../config/settings.js';

/*
  The hooks this extension fires, in notification mode: every handler runs, a handler that throws
  is logged and stops nothing, and nothing a handler does can undo the change it is hearing about.
  They fire after the change is committed, so a handler that reads the balance sees the new one.

  `credits:low` fires once each time a balance crosses below the `low_balance_threshold` setting, in
  either an operation that lowers it — a spend, a removal, a claw back. It is worked out from the
  balance before and after that one operation, inside its lock, so it needs no state of its own and
  cannot fire twice for one crossing.
*/
export const EVENTS = [
  'credits:granted',     // { userId, operationId, lot, amount, kind, reason, reference, settled, balance }
  'credits:transferred', // { fromUserId, toUserId, operationId, amount, reason, reference, settled, fromBalance, toBalance }
  'credits:spent',       // { userId, operationId, amount, reason, reference, entries, balance }
  'credits:reversed',    // { userId, operationId, reversedOperationId, amount, reference, balance }
  'credits:clawed-back', // { userId, operationId, lot, taken, shortfall, unrecovered, owed, balance }
  'credits:low',         // { userId, balance, threshold }
];

export const fire = async (event, data) => {
  const [error] = await triggerHook(event, data);
  if(error) console.warn(`[${OWNER}] Could not fire ${event}: ${error.msg}`);
};

export const crossedLow = (before, after, threshold) => threshold > 0 && before.total >= threshold && after.total < threshold;

/*
  Tells whoever can see credits that something needs a person: a shortfall, a dispute. The admin
  bell is where that is noticed; a console line is not.
*/
export const notifyAdmins = async ({ title, message, level = 'warning', dedupeKey, url }) => {
  const [error] = await createNotification({
    owner: OWNER,
    title,
    message,
    level,
    dedupeKey,
    permission: 'credits:view',
    actions: url ? [{ label: 'Open', href: url }] : undefined,
  });
  if(error) console.warn(`[${OWNER}] Could not notify administrators: ${error.msg}`);
};
