import { eq } from 'drizzle-orm';
import { setSetting, deleteSetting } from 'kempo/server/sdk.js';
import { extension } from 'kempo/server/db/schema.js';
import { kempoCreditPurchase } from '../server/db/schema.js';
import { createPack } from '../server/utils/packs/store.js';
import startPurchase from '../server/utils/purchases/start.js';
import { getPurchase, updatePurchase } from '../server/utils/purchases/store.js';
import { priceFor, taxModule } from '../server/utils/purchases/tax.js';
import { readConfig } from '../server/utils/config/settings.js';
import { getBalance } from '../server/utils/ledger/read.js';
import { db } from './helpers/db.js';
import { freshUser, purge } from './helpers/ledger.js';
import {
  connectStripe, deliver, disconnectStripe, purgePayments, registerCreditHooks, startedPurchase, stripeEvent, unregisterCreditHooks,
} from './helpers/payments.js';

/*
  Buying with kempo-tax installed — and without it, since it is optional and must be ignored when it
  is not there or not enabled.

  kempo-tax runs on its own rate-table provider here: a 6% rate for Vermont, worked out locally, so
  nothing reaches Stripe Tax. Whether a sale is recorded and a refund reversed is read back from
  kempo-tax's own ledger.
*/

const VERMONT = { country: 'US', state: 'VT', postalCode: '05401', city: 'Burlington', line1: '1 Main St' };

let pack;
let tax;

const enableTax = enabled => db.insert(extension)
  .values({ name: 'kempo-tax', version: '0.2.2', enabled, kempo: {}, installedAt: new Date(), updatedAt: new Date() })
  .onConflictDoUpdate({ target: extension.name, set: { enabled, updatedAt: new Date() } });

// kempo-tax exports only its SDK, so its tables are imported by path.
const taxRows = () => import(new URL('../node_modules/kempo-tax/server/db/schema.js', import.meta.url).href);

export const beforeAll = async () => {
  await purge();
  await purgePayments();
  await disconnectStripe();
  await registerCreditHooks();
  await setSetting('kempo-tax', 'provider', 'rates', 'string', false, null);
  await setSetting('kempo-tax', 'prices_include_tax', false, 'boolean', false, null);
  [, pack] = await createPack({ name: 'Starter', credits: 500, price: 499, currency: 'usd' });

  await enableTax(true);
  tax = await taxModule();
  await tax.createRate({ country: 'US', state: 'VT', rate: '6', taxClass: '*', label: 'Vermont' });
};

export const afterAll = async () => {
  await db.delete(extension).where(eq(extension.name, 'kempo-tax'));
  const { kempoTaxEntry, kempoTaxQuote, kempoTaxRate } = await taxRows();
  for(const table of [kempoTaxEntry, kempoTaxQuote, kempoTaxRate]) if(table) await db.delete(table).catch(() => {});
  for(const name of ['provider', 'prices_include_tax']) await deleteSetting('kempo-tax', name).catch(() => {});
  await unregisterCreditHooks();
  await disconnectStripe();
  await purgePayments();
  await purge();
};

export default {
  'without kempo-tax enabled, a pack costs its price and needs no address': async ({ pass, fail }) => {
    await enableTax(false);
    try {
      if(await taxModule()) return fail('a disabled kempo-tax was used');
      const [error, price] = await priceFor({ pack, address: null, config: await readConfig() });
      if(error) return fail(error.msg);
      if(price.total !== 499 || price.tax !== 0 || price.enabled) return fail(`priced ${JSON.stringify(price)}`);
      pass('');
    } finally {
      await enableTax(true);
    }
  },

  'with kempo-tax, the address decides the tax, and the total is what is charged': async ({ pass, fail }) => {
    const user = freshUser();

    const [noAddress] = await startPurchase({ userId: user, packId: pack.id });
    if(noAddress?.code !== 400) return fail(`with no address: ${noAddress?.code ?? 'success'}`);

    const [error] = await startPurchase({ userId: user, packId: pack.id, address: VERMONT });
    if(error?.code !== 409) return fail(`expected to stop at the unconnected processor, got ${error?.code}: ${error?.msg}`);

    const [row] = await db.select().from(kempoCreditPurchase).where(eq(kempoCreditPurchase.userId, user));
    // 6% of $4.99 is 29.94¢
    if(row.subtotal !== 499 || row.tax !== 30 || row.total !== 529) return fail(`priced ${row.subtotal} + ${row.tax} = ${row.total}`);
    if(!row.taxCalculationId) return fail('the tax calculation was not kept for recording the sale');
    if(!row.shown.taxed || row.shown.tax !== 30 || row.shown.total !== 529) return fail(`shown ${JSON.stringify(row.shown)}`);

    const [, elsewhere] = await priceFor({ pack, address: { country: 'US', state: 'NH' }, config: await readConfig() });
    if(elsewhere.tax !== 0 || elsewhere.total !== 499) return fail(`New Hampshire was charged ${elsewhere.tax}`);
    pass('');
  },

  'a paid, taxed purchase is recorded in the tax ledger, and its refund reversed': async ({ pass, fail }) => {
    await connectStripe();
    const user = freshUser();
    const [, price] = await priceFor({ pack, address: VERMONT, config: await readConfig() });
    const { purchase, payment } = await startedPurchase({ userId: user, pack, total: price.total });
    await updatePurchase(purchase.id, { taxCalculationId: price.calculationId });

    await deliver(stripeEvent.succeeded(payment));
    const [, paid] = await getPurchase({ purchaseId: purchase.id });
    if(paid.status !== 'paid') return fail(`purchase is ${paid.status}`);
    if(!paid.taxTransactionId || paid.taxError) return fail(`not recorded: ${paid.taxError}`);
    if((await getBalance({ userId: user }))[1].total !== 500) return fail('the credits were not granted');

    const [, sale] = await tax.getEntryByReference('sale', `kempo-credits:${purchase.id}`);
    if(!sale || sale.taxAmount !== 30 || sale.salesAmount !== 499) return fail(`kempo-tax recorded ${JSON.stringify(sale)}`);

    await deliver(stripeEvent.refunded(payment, 529));
    const [, refunded] = await getPurchase({ purchaseId: purchase.id });
    if(refunded.status !== 'refunded' || refunded.taxError) return fail(`after the refund: ${refunded.status}, ${refunded.taxError}`);

    const { kempoTaxEntry } = await taxRows();
    const reversals = await db.select().from(kempoTaxEntry).where(eq(kempoTaxEntry.kind, 'reversal'));
    if(!reversals.some(entry => entry.reference.startsWith(`kempo-credits:${purchase.id}:refund:`))) return fail('the refund was not reversed in the tax ledger');
    pass('');
  },

  'prices that include tax are charged as they are, with the tax inside': async ({ pass, fail }) => {
    await setSetting('kempo-tax', 'prices_include_tax', true, 'boolean', false, null);
    try {
      const [error, price] = await priceFor({ pack, address: VERMONT, config: await readConfig() });
      if(error) return fail(error.msg);
      if(price.total !== 499 || !price.includesTax) return fail(`priced ${JSON.stringify(price)}`);
      if(price.tax !== 28) return fail(`the tax inside $4.99 at 6% should be 28¢, was ${price.tax}`);
      pass('');
    } finally {
      await setSetting('kempo-tax', 'prices_include_tax', false, 'boolean', false, null);
    }
  },

  'a tax engine that cannot answer stops the purchase rather than charging no tax': async ({ pass, fail }) => {
    await disconnectStripe();
    await setSetting('kempo-tax', 'provider', 'stripe', 'string', false, null);
    try {
      const user = freshUser();
      const [error] = await startPurchase({ userId: user, packId: pack.id, address: VERMONT });
      if(error?.code !== 409 || !/stripe|tax|key|connected/i.test(error.msg)) return fail(`got ${error?.code}: ${error?.msg}`);
      const rows = await db.select().from(kempoCreditPurchase).where(eq(kempoCreditPurchase.userId, user));
      if(rows.length) return fail('a purchase was started without its tax');
      pass('');
    } finally {
      await setSetting('kempo-tax', 'provider', 'rates', 'string', false, null);
    }
  },
};
