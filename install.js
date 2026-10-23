import { createIndexes, ensureColumns } from './server/db/indexes.js';

/*
  What kempo-config.json cannot say: the indexes. kempo's installer makes this extension's tables
  from the Drizzle schema with their columns and primary keys and nothing else — indexes declared in
  the schema are not carried across, and one of them is what makes a retried request grant once. See
  server/db/indexes.js. If it cannot be made the install fails rather than going ahead without it.

  Nobody holds `credits:transfer` after installing. Sending credits between users is something a
  site turns on by giving that permission to a group, deliberately.
*/

/*
  The product type a credit pack is sold as: nothing is shipped for it. kempo-products keeps the type; this extension
  owns it. Credits work without products (a game that only earns them has no store), so kempo-products is optional: when
  it is not there nothing is registered, and when it is but cannot take the type, that is a warning, not a failed install.
*/
export const registerCreditsProductType = async () => {
  try {
    const { registerProductType, CREDITS_ONLY } = await import('kempo-products/sdk');
    const [error] = await registerProductType('kempo-credits', { key: CREDITS_ONLY, name: 'Credits Only', description: 'Buying it gives credits and nothing else', needsShipping: false });
    if(error) throw new Error(error.msg);
  } catch(error) {
    if(error.code === 'ERR_MODULE_NOT_FOUND') return;
    console.warn(`[kempo-credits] The Credits Only product type was not registered: ${error.message}`);
  }
};

export default async () => {
  await ensureColumns();
  await createIndexes();
  await registerCreditsProductType();
  console.log('[kempo-credits] Installed. Other extensions grant credits through kempo-credits/sdk; to sell them, install kempo-credit-packs.');
};
