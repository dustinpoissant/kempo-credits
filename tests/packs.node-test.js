import { createPack, deletePack, getPack, listPacks, updatePack } from '../server/utils/packs/store.js';
import { insertPurchase } from '../server/utils/purchases/store.js';
import { freshUser, purge } from './helpers/ledger.js';

/*
  The packs an administrator sells, and the prices the purchase flow is allowed to charge.
*/

export const beforeAll = purge;
export const afterAll = purge;

export default {
  'a pack is created in the payments currency, listed in order, and edited': async ({ pass, fail }) => {
    const [error, small] = await createPack({ name: 'Small', credits: 100, price: 99 });
    if(error) return fail(error.msg);
    if(small.currency !== 'usd') return fail(`defaulted to ${small.currency}`);
    await createPack({ name: 'Large', credits: 2000, price: 1499, sort: -1 });

    const [, all] = await listPacks();
    if(all.map(pack => pack.name).join() !== 'Large,Small') return fail(`listed ${all.map(pack => pack.name).join()}`);

    const [, edited] = await updatePack({ packId: small.id, price: 129, enabled: false });
    if(edited.price !== 129 || edited.enabled) return fail('the edit was not saved');
    const [, onSale] = await listPacks({ enabledOnly: true });
    if(onSale.some(pack => pack.id === small.id)) return fail('a disabled pack is listed as on sale');
    pass('');
  },

  'a price or credit count that is not a whole number is refused': async ({ pass, fail }) => {
    const cases = [
      [{ name: 'A', credits: 100, price: 4.99 }, 'a price in major units'],
      [{ name: 'A', credits: 100, price: 0 }, 'a free pack'],
      [{ name: 'A', credits: 10.5, price: 99 }, 'fractional credits'],
      [{ name: '', credits: 10, price: 99 }, 'no name'],
      [{ name: 'A', credits: 10, price: 99, currency: 'dollars' }, 'a currency that is not one'],
      [{ name: 'A', credits: 10, price: 1005, currency: 'kwd' }, 'a three-decimal amount Stripe cannot charge'],
    ];
    for(const [input, label] of cases){
      const [error] = await createPack(input);
      if(error?.code !== 400) return fail(`${label} gave ${error?.code ?? 'success'}`);
    }
    pass(`${cases.length} refusals`);
  },

  'a pack that has been bought can be disabled but not deleted': async ({ pass, fail }) => {
    const [, sold] = await createPack({ name: 'Sold', credits: 10, price: 99 });
    await insertPurchase({ userId: freshUser(), status: 'paid', packId: sold.id, credits: 10 });
    const [error] = await deletePack({ packId: sold.id });
    if(error?.code !== 409) return fail(`gave ${error?.code ?? 'success'}`);

    const [, unsold] = await createPack({ name: 'Unsold', credits: 10, price: 99 });
    const [deleteError] = await deletePack({ packId: unsold.id });
    if(deleteError) return fail(deleteError.msg);
    const [gone] = await getPack({ packId: unsold.id });
    if(gone?.code !== 404) return fail('the pack is still there');
    pass('');
  },
};
