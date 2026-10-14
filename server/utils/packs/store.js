import { asc, eq, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { isValidAmount, isValidCurrency, normaliseCurrency, readConfig as readPaymentsConfig } from 'kempo-payments/sdk';
import { kempoCreditPack, kempoCreditPurchase } from '../../db/schema.js';
import newId from '../ids.js';
import { cleanAmount, cleanText } from '../ledger/validate.js';

/*
  The packs an administrator sells. A pack's price is the only amount a purchase ever charges: the
  browser names a pack, and the server looks up what it costs.
*/

const clean = (input, { partial = false } = {}) => {
  const changes = {};

  if(!partial || input.name !== undefined){
    const [error, name] = cleanText(input.name, 'A name', { required: true, max: 100 });
    if(error) return [error, null];
    changes.name = name;
  }

  if(input.description !== undefined){
    const [error, description] = cleanText(input.description, 'A description', { max: 500 });
    if(error) return [error, null];
    changes.description = description;
  }

  if(!partial || input.credits !== undefined){
    const [error] = cleanAmount(input.credits, 'Credits');
    if(error) return [error, null];
    changes.credits = input.credits;
  }

  if(input.currency !== undefined){
    const currency = normaliseCurrency(input.currency);
    if(!isValidCurrency(currency)) return [{ code: 400, msg: 'Currency must be a three-letter code, such as usd' }, null];
    changes.currency = currency;
  }

  if(!partial || input.price !== undefined){
    if(!Number.isSafeInteger(input.price) || input.price <= 0){
      return [{ code: 400, msg: 'Price must be a whole number of the currency’s smallest unit — 499 for $4.99' }, null];
    }
    changes.price = input.price;
  }

  if(input.enabled !== undefined){
    if(typeof input.enabled !== 'boolean') return [{ code: 400, msg: 'Enabled is true or false' }, null];
    changes.enabled = input.enabled;
  }

  if(input.sort !== undefined){
    if(!Number.isSafeInteger(input.sort)) return [{ code: 400, msg: 'Sort order must be a whole number' }, null];
    changes.sort = input.sort;
  }

  return [null, changes];
};

const checkPrice = pack => isValidAmount(pack.price, pack.currency)
  ? [null, pack]
  : [{ code: 400, msg: `${pack.price} is not a chargeable amount in ${pack.currency.toUpperCase()}` }, null];

export const listPacks = async ({ enabledOnly = false } = {}) => {
  try {
    const rows = await db.select().from(kempoCreditPack)
      .where(enabledOnly ? eq(kempoCreditPack.enabled, true) : undefined)
      .orderBy(asc(kempoCreditPack.sort), asc(kempoCreditPack.price), asc(kempoCreditPack.createdAt));
    return [null, rows];
  } catch {
    return [{ code: 500, msg: 'Could not load the packs' }, null];
  }
};

export const getPack = async ({ packId } = {}) => {
  if(typeof packId !== 'string' || !packId || packId.length > 100) return [{ code: 400, msg: 'A pack id is required' }, null];

  try {
    const [pack] = await db.select().from(kempoCreditPack).where(eq(kempoCreditPack.id, packId)).limit(1);
    return pack ? [null, pack] : [{ code: 404, msg: 'No such pack' }, null];
  } catch {
    return [{ code: 500, msg: 'Could not load the pack' }, null];
  }
};

/*
  The currency defaults to the one kempo-payments takes payments in, so a site with one currency
  never has to think about it.
*/
export const createPack = async (input = {}) => {
  const [error, values] = clean(input);
  if(error) return [error, null];

  const now = new Date();
  const pack = {
    id: newId('pack'),
    description: null,
    enabled: true,
    sort: 0,
    ...values,
    currency: values.currency || (await readPaymentsConfig()).currency,
    createdAt: now,
    updatedAt: now,
  };

  const [priceError] = checkPrice(pack);
  if(priceError) return [priceError, null];

  try {
    await db.insert(kempoCreditPack).values(pack);
    return [null, pack];
  } catch {
    return [{ code: 500, msg: 'Could not save the pack' }, null];
  }
};

/*
  Changing a pack never changes a purchase already made from it: each purchase keeps its own copy of
  the name, credits and price it was sold at.
*/
export const updatePack = async ({ packId, ...input } = {}) => {
  const [loadError, pack] = await getPack({ packId });
  if(loadError) return [loadError, null];

  const [error, changes] = clean(input, { partial: true });
  if(error) return [error, null];
  if(!Object.keys(changes).length) return [{ code: 400, msg: 'Nothing to change' }, null];

  const [priceError] = checkPrice({ ...pack, ...changes });
  if(priceError) return [priceError, null];

  try {
    const [row] = await db.update(kempoCreditPack)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(kempoCreditPack.id, pack.id))
      .returning();
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not save the pack' }, null];
  }
};

/*
  A pack that has been bought is disabled, never deleted: its purchases point at it, and a receipt
  that cannot say what was bought is not a receipt.
*/
export const deletePack = async ({ packId } = {}) => {
  const [loadError, pack] = await getPack({ packId });
  if(loadError) return [loadError, null];

  try {
    const [{ count }] = await db.select({ count: sql`count(*)::int` }).from(kempoCreditPurchase).where(eq(kempoCreditPurchase.packId, pack.id));
    if(count) return [{ code: 409, msg: 'This pack has been bought, so it can only be disabled — its purchases still point at it' }, null];
    await db.delete(kempoCreditPack).where(eq(kempoCreditPack.id, pack.id));
    return [null, { deleted: true, packId: pack.id }];
  } catch {
    return [{ code: 500, msg: 'Could not delete the pack' }, null];
  }
};
