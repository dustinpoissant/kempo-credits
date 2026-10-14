import { join } from 'path';
import { pathToFileURL } from 'url';
import { getExtension } from 'kempo/server/sdk.js';

/*
  kempo-tax, when it is there.

  It is an optional dependency: used when it is installed *and* enabled, ignored otherwise. So it is
  never imported statically — a site without it must be able to load this extension at all — and it
  is looked up on every purchase rather than once, so enabling or disabling it takes effect without
  a restart.

  It is imported by name first, which is how a site that installed both from npm resolves it, and
  then from the site's own node_modules, which is where kempo itself looks for extensions and where
  it is when this package is linked from elsewhere during development.
*/

const load = async () => {
  try {
    return await import('kempo-tax/sdk');
  } catch {
    return import(pathToFileURL(join(process.cwd(), 'node_modules', 'kempo-tax', 'sdk.js')).href);
  }
};

export const taxModule = async () => {
  const [error, extension] = await getExtension({ name: 'kempo-tax' });
  if(error || !extension?.enabled) return null;

  try {
    const sdk = await load();
    return typeof sdk?.calculateTax === 'function' ? sdk : null;
  } catch {
    console.warn('[kempo-credits] kempo-tax is enabled but could not be loaded, so purchases are not being taxed');
    return null;
  }
};

/*
  What a pack costs this buyer. Without kempo-tax it is the pack's price. With it, the price goes
  through `calculateTax` as one line of the `tax_class` setting, and the result decides the total:
  added on top where prices exclude tax, already inside where they include it — kempo-tax's own
  `prices_include_tax` setting, which this extension works with either way.

  A tax calculation that fails stops the purchase. Charging without tax where tax is owed is a
  liability that grows with every sale; a purchase that refuses is fixed the same afternoon.
*/
export const priceFor = async ({ pack, address, config }) => {
  const tax = await taxModule();

  if(!tax){
    return [null, { enabled: false, subtotal: pack.price, tax: 0, total: pack.price, includesTax: false, calculationId: null }];
  }

  if(!address || typeof address !== 'object'){
    return [{ code: 400, msg: 'A billing address is needed to work out the tax on this purchase' }, null];
  }

  const [error, quote] = await tax.calculateTax({
    address,
    currency: pack.currency,
    lines: [{ amount: pack.price, reference: pack.id, taxClass: config.taxClass }],
  });
  if(error) return [error, null];

  const includesTax = (quote.taxAmountInclusive || 0) > 0 || quote.lines?.[0]?.taxBehavior === 'inclusive';

  return [null, {
    enabled: true,
    subtotal: pack.price,
    tax: quote.tax,
    total: quote.total,
    includesTax,
    calculationId: quote.calculationId,
  }];
};
