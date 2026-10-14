import path from 'path';
import { eq } from 'drizzle-orm';
import { deleteSetting, setSetting } from 'kempo/server/sdk.js';
import { kempoCreditPack } from '../server/db/schema.js';
import spendCredits from '../server/utils/ledger/spend.js';
import { getBalance } from '../server/utils/ledger/read.js';
import { integrationOnly, integrationTier, db } from './helpers/db.js';
import { purge } from './helpers/ledger.js';
import { purgePayments } from './helpers/payments.js';
import {
  USERS, buildSite, call, forwardStripe, joinExtensionGroups, login, purgeSite, screensDir, seedPeople, startServer, stopServer,
} from './helpers/site.js';

/*
  The extension in a real browser, on a real kempo site, through every screen.

  A throwaway site is built and served by this suite (see helpers/site.js); kempo-payments and this
  extension are installed into it through kempo's own install route, the way an administrator
  would. Chromium is driven by Playwright. Each screen is opened, used, and checked for console
  errors, and a screenshot of each is saved to tests/.tmp-site/screens.

  The HTTP contract — who may reach which route — is checked over plain HTTP for every audience:
  nobody, a member, the support group and an administrator.

  Buying with a real card needs Stripe test keys, given as STRIPE_TEST_SECRET_KEY and
  STRIPE_TEST_PUBLISHABLE_KEY (test keys only — anything else is refused). Without them those cases
  say so and pass; everything else still runs.

  Integration tier only: it needs a real Postgres and a second server process.
*/

const state = { server: null, browser: null, tokens: {}, ids: {}, errors: [], token: null };

const secretKey = process.env.STRIPE_TEST_SECRET_KEY || '';
const publishableKey = process.env.STRIPE_TEST_PUBLISHABLE_KEY || '';
const stripe = secretKey.startsWith('sk_test_') && publishableKey.startsWith('pk_test_');

/*
  Console errors on our pages are failures. A missing icon is not: k-icon looks for each icon in
  several places in turn and the misses are 404s by design.
*/
const IGNORED = [/Failed to load resource.*404/, /icons\//, /favicon/];

const newPage = async who => {
  const context = await state.browser.newContext({ viewport: { width: 1280, height: 900 } });
  if(who) await context.addCookies([{ name: 'session_token', value: state.tokens[who], url: state.server.base }]);
  const page = await context.newPage();
  state.page = page;
  page.on('console', message => {
    if(message.type() === 'error' && !IGNORED.some(pattern => pattern.test(message.text()))) state.errors.push(`${who || 'anonymous'} ${page.url()}: ${message.text()}`);
  });
  page.on('pageerror', error => state.errors.push(`${who || 'anonymous'} ${page.url()}: ${error.message}`));
  return page;
};

const shot = (page, name) => page.screenshot({ path: path.join(screensDir, `${name}.png`), fullPage: true });

const errorsSince = start => state.errors.slice(start);

const tab = async (page, name) => {
  await page.locator(`k-tab[for="${name}"]`).click();
  await page.waitForTimeout(400);
};

const NO_STRIPE = 'skipped: set STRIPE_TEST_SECRET_KEY and STRIPE_TEST_PUBLISHABLE_KEY (test keys) to run it';

/*
  Types into Stripe's own card fields, which are iframes from Stripe's origin — exactly as a buyer
  would. Nothing here, or in the site, ever sees the number.
*/
const fillCard = async (page, number) => {
  await page.frameLocator('iframe[title*="card number" i]').first().locator('input[name="cardnumber"]').fill(number);
  await page.frameLocator('iframe[title*="expiration" i]').first().locator('input[name="exp-date"]').fill('12 / 34');
  await page.frameLocator('iframe[title*="CVC" i]').first().locator('input[name="cvc"]').fill('123');
};

const poll = async (check, timeout = 30000) => {
  const until = Date.now() + timeout;
  while(Date.now() < until){
    const result = await check();
    if(result) return result;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return null;
};

const tests = {
  'a site boots, and kempo-payments then kempo-credits install through kempo’s own route': async ({ pass, fail }) => {
    await purgeSite();
    await purge();
    await purgePayments();
    await buildSite();
    state.ids = await seedPeople();
    state.server = await startServer();

    state.tokens.admin = await login(state.server.base, USERS.admin);
    if(!state.tokens.admin) return fail('the administrator could not sign in');

    for(const name of ['kempo-payments', 'kempo-credits']){
      const installed = await call(state.server.base, 'POST', '/kempo/api/extensions', { token: state.tokens.admin, body: { name } });
      if(installed.status !== 200) return fail(`installing ${name}: ${installed.status} ${JSON.stringify(installed.data)}`);
    }

    await joinExtensionGroups(state.ids);
    for(const who of ['support', 'member', 'buyer', 'decliner']){
      state.tokens[who] = await login(state.server.base, USERS[who]);
      if(!state.tokens[who]) return fail(`${who} could not sign in`);
    }

    const { chromium } = await import('playwright');
    state.browser = await chromium.launch();
    pass(state.server.base);
  },

  'every route answers each audience as it should': async ({ pass, fail }) => {
    if(!state.server) return fail('no site');
    const contract = [
      ['GET', '/credits/', null, 200],
      ['GET', '/credits/claim', null, 200],
      ['GET', '/credits/api/packs', null, 200],
      ['GET', '/credits/api/checkout', null, 200],
      ['GET', '/credits/api/my/balance', null, 401],
      ['GET', '/credits/api/my/balance', 'member', 200],
      ['GET', '/credits/api/my/entries', 'member', 200],
      ['GET', '/credits/api/my/purchases', 'member', 200],
      ['POST', '/credits/api/my/purchases', null, 401],
      ['POST', '/credits/api/claims/redeem', null, 401],
      ['GET', '/credits/api/packs?all=1', 'member', 403],
      ['GET', '/credits/api/packs?all=1', 'support', 403],
      ['GET', '/credits/api/packs?all=1', 'admin', 200],
      ['POST', '/credits/api/packs', 'support', 403],
      ['GET', '/credits/api/accounts', null, 401],
      ['GET', '/credits/api/accounts', 'member', 403],
      ['GET', '/credits/api/accounts', 'support', 200],
      ['GET', '/credits/api/accounts', 'admin', 200],
      ['GET', '/credits/api/purchases', 'member', 403],
      ['GET', '/credits/api/purchases', 'support', 200],
      ['GET', '/credits/api/summary', 'member', 403],
      ['GET', '/credits/api/summary', 'support', 200],
      ['GET', '/credits/api/claims', 'member', 403],
      ['GET', '/credits/api/claims', 'support', 200],
      ['POST', `/credits/api/accounts/${encodeURIComponent('someone')}/grant`, 'member', 403],
      ['POST', `/credits/api/accounts/${encodeURIComponent('someone')}/remove`, 'support', 403],
      ['POST', `/credits/api/accounts/${encodeURIComponent('someone')}/forgive`, 'support', 403],
      ['POST', '/credits/api/lots/lot_x/claw-back', 'support', 403],
      ['POST', '/credits/api/operations/op_x/reverse', 'support', 403],
      ['GET', '/credits/api/settings', 'support', 403],
      ['GET', '/credits/api/settings', 'admin', 200],
      ['PUT', '/credits/api/settings', 'support', 403],
      ['GET', '/admin/extension/kempo-credits/', null, 302],
      ['GET', '/admin/extension/kempo-credits/', 'member', 302],
      ['GET', '/admin/extension/kempo-credits/', 'admin', 200],
    ];

    const wrong = [];
    for(const [method, url, who, expected] of contract){
      const { status } = await call(state.server.base, method, url, { token: who ? state.tokens[who] : null, body: method === 'GET' ? undefined : {} });
      if(status !== expected) wrong.push(`${method} ${url} as ${who || 'nobody'}: expected ${expected}, got ${status}`);
    }
    if(wrong.length) return fail(`\n    ${wrong.join('\n    ')}`);
    pass(`${contract.length} route/audience pairs`);
  },

  'every admin tab loads, for an administrator, without a console error': async ({ pass, fail }) => {
    const start = state.errors.length;
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/`);
    await page.waitForSelector('k-cred-balances');

    for(const name of ['balances', 'grant', 'purchases', 'packs', 'claims', 'settings']){
      await tab(page, name);
      if(!await page.locator(`k-tab-content[name="${name}"]`).isVisible()) return fail(`the ${name} tab did not open`);
      await shot(page, `admin-${name}`);
    }

    await page.context().close();
    const errors = errorsSince(start);
    if(errors.length) return fail(`\n    ${errors.join('\n    ')}`);
    pass('');
  },

  'the nav links to the screen, under Commerce': async ({ pass, fail }) => {
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/`);
    const link = page.locator('k-aside-item[href="/admin/extension/kempo-credits/"]');
    if(!await link.count()) return fail('no Credits link in the admin nav');
    if(await link.getAttribute('group') !== 'Commerce') return fail('the link is not in the Commerce group');
    await page.context().close();
    pass('');
  },

  'an administrator creates a pack through the Packs screen': async ({ pass, fail }) => {
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/`);
    await tab(page, 'packs');
    const packs = page.locator('k-cred-packs');

    await packs.getByRole('button', { name: 'New pack' }).click();
    await packs.getByLabel('Name').fill('Starter');
    await packs.getByLabel('Credits').fill('500');
    await packs.getByLabel(/^Price/).fill('4.99');
    await packs.getByLabel(/^Description/).fill('Enough for a few events');
    await packs.getByRole('button', { name: 'Save' }).click();
    await packs.locator('td', { hasText: 'Starter' }).waitFor();
    await shot(page, 'admin-packs-created');

    const [row] = await db.select().from(kempoCreditPack).where(eq(kempoCreditPack.name, 'Starter'));
    if(!row || row.price !== 499 || row.credits !== 500) return fail(`saved ${JSON.stringify(row)}`);

    const shown = await page.locator('k-cred-packs').locator('td', { hasText: '$4.99' }).count();
    if(!shown) return fail('the price is not shown as $4.99');
    await page.context().close();
    pass('');
  },

  'an administrator makes a claim link, and it is shown once': async ({ pass, fail }) => {
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/`);
    await tab(page, 'claims');
    const claims = page.locator('k-cred-claims');

    await claims.getByRole('button', { name: 'New claim link' }).click();
    await claims.getByLabel(/^Name/).fill('Launch week');
    await claims.getByLabel('Credits each').fill('150');
    await claims.getByLabel(/^Limit/).fill('100');
    await claims.getByRole('button', { name: 'Make the link' }).click();

    const url = await claims.locator('#made-url').inputValue();
    if(!url.includes('/credits/claim?token=')) return fail(`the link shown is ${url}`);
    state.token = new URL(url).searchParams.get('token');
    await shot(page, 'admin-claim-made');

    await page.reload();
    await tab(page, 'claims');
    const page2 = await page.locator('k-cred-claims').innerHTML();
    if(page2.includes(state.token)) return fail('the token is shown again after a reload');
    await page.context().close();
    pass('');
  },

  'a member claims the link and sees the credits on their page': async ({ pass, fail }) => {
    if(!state.token) return fail('no claim link from the previous case');
    const start = state.errors.length;

    const anonymous = await newPage(null);
    await anonymous.goto(`${state.server.base}/credits/claim?token=${state.token}`);
    await anonymous.locator('k-cred-claim').getByText('150 free credits').waitFor();
    if(!await anonymous.locator('k-cred-claim').getByRole('link', { name: 'Sign in' }).count()) return fail('a signed-out visitor is not asked to sign in');
    await shot(anonymous, 'claim-signed-out');
    await anonymous.context().close();

    const page = await newPage('member');
    await page.goto(`${state.server.base}/credits/claim?token=${state.token}`);
    await page.locator('k-cred-claim').getByRole('button', { name: 'Claim them' }).click();
    await page.locator('k-cred-claim').getByText('150 credits added').waitFor();
    await shot(page, 'claim-done');

    await page.goto(`${state.server.base}/credits/`);
    await page.locator('k-cred-balance').getByText('150').first().waitFor();
    await page.locator('k-cred-history').getByText('Claimed from a link').waitFor();
    await page.locator('k-cred-buy').getByText('500 credits').waitFor();
    await shot(page, 'wallet-member');
    await page.context().close();

    const errors = errorsSince(start);
    if(errors.length) return fail(`\n    ${errors.join('\n    ')}`);
    pass('');
  },

  'an administrator gives and takes credits from a member’s ledger, and the audit holds': async ({ pass, fail }) => {
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/?user=${state.ids.member}`);
    const account = page.locator('k-cred-account');
    await account.getByText('Credits Member').waitFor();

    await account.getByRole('button', { name: 'Give promo credits' }).click();
    await account.getByLabel('Credits').fill('50');
    await account.getByLabel('Why (required').fill('Sorry about the outage');
    await account.getByRole('button', { name: 'Give credits' }).click();
    await account.getByText('Done.').waitFor();

    await account.getByRole('button', { name: 'Take credits away' }).click();
    await account.getByLabel('Credits').fill('20');
    await account.getByLabel('Why (required').fill('Granted twice by mistake');
    await account.getByRole('button', { name: 'Take them away' }).click();
    await account.getByText('Done.').waitFor();

    const balance = await call(state.server.base, 'GET', '/credits/api/my/balance', { token: state.tokens.member });
    if(balance.data?.balance?.total !== 180) return fail(`the member's balance is ${balance.data?.balance?.total}, expected 150 + 50 - 20`);

    await account.getByText('The ledger proves this balance').waitFor();
    await account.getByText('Sorry about the outage').first().waitFor();
    await shot(page, 'admin-account');
    await page.context().close();
    pass('');
  },

  'the support group sees balances and can give credits, and nothing else': async ({ pass, fail }) => {
    const page = await newPage('support');
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/`);
    await page.waitForSelector('k-cred-balances');
    await page.waitForTimeout(800);

    const visible = {};
    for(const name of ['balances', 'grant', 'purchases', 'packs', 'claims', 'settings']){
      visible[name] = await page.locator(`k-tab[for="${name}"]`).isVisible();
    }
    const expected = { balances: true, grant: true, purchases: true, packs: false, claims: true, settings: false };
    if(JSON.stringify(visible) !== JSON.stringify(expected)) return fail(`tabs visible: ${JSON.stringify(visible)}`);

    await page.goto(`${state.server.base}/admin/extension/kempo-credits/?user=${state.ids.member}`);
    const account = page.locator('k-cred-account');
    await account.getByText('Credits Member').waitFor();
    if(!await account.getByRole('button', { name: 'Give promo credits' }).count()) return fail('support cannot give credits');
    if(await account.getByRole('button', { name: 'Take credits away' }).count()) return fail('support is offered taking credits away');
    if(await account.getByRole('button', { name: 'Claw back' }).count()) return fail('support is offered claw back');
    await shot(page, 'support-account');
    await page.context().close();
    pass('');
  },

  'settings save, and a typo is refused rather than ignored': async ({ pass, fail }) => {
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/`);
    await tab(page, 'settings');
    const settings = page.locator('k-cred-settings');

    await settings.getByLabel('Attempts per account').fill('7');
    await settings.getByRole('button', { name: 'Save' }).click();
    await settings.getByText('Saved.').waitFor();

    const saved = await call(state.server.base, 'GET', '/credits/api/settings', { token: state.tokens.admin });
    const limit = saved.data.settings.find(setting => setting.name === 'purchase_limit_per_user');
    if(limit.value !== 7) return fail(`saved as ${limit.value}`);

    await settings.getByText('Credits never expire, bought or promo.').waitFor();
    await shot(page, 'admin-settings-saved');

    const typo = await call(state.server.base, 'PUT', '/credits/api/settings', { token: state.tokens.admin, body: { purchase_limit_per_usr: 3 } });
    if(typo.status !== 400) return fail(`a misspelt setting gave ${typo.status}`);
    await page.context().close();
    pass('');
  },

  'without a payment processor, the buy page says so instead of failing silently': async ({ pass, fail }) => {
    const page = await newPage('buyer');
    await page.goto(`${state.server.base}/credits/`);
    const buy = page.locator('k-cred-buy');
    await buy.getByRole('button', { name: 'Continue' }).click();
    await buy.getByText(/not connected/i).waitFor();
    await shot(page, 'buy-not-connected');
    await page.context().close();
    pass('');
  },

  'a buyer pays for a pack with a test card, and the credits arrive': async ({ pass, fail }) => {
    if(!stripe) return pass(NO_STRIPE);

    await setSetting('kempo-payments', 'stripe_secret_key', secretKey, 'secret', false, 'Stripe secret key');
    await setSetting('kempo-payments', 'stripe_publishable_key', publishableKey, 'string', false, 'Stripe publishable key');

    const start = state.errors.length;
    const page = await newPage('buyer');
    await page.goto(`${state.server.base}/credits/`);
    const buy = page.locator('k-cred-buy');
    await buy.getByRole('button', { name: 'Continue' }).click();
    await buy.getByText('Refunds:').waitFor({ timeout: 20000 });
    await fillCard(page, '4242424242424242');
    await shot(page, 'buy-card');

    await buy.getByRole('button', { name: /^Pay / }).click();
    await buy.getByText('500 credits added').waitFor({ timeout: 90000 });
    await shot(page, 'buy-done');
    await page.context().close();

    const balance = await call(state.server.base, 'GET', '/credits/api/my/balance', { token: state.tokens.buyer });
    if(balance.data?.balance?.paid !== 500) return fail(`the buyer has ${JSON.stringify(balance.data?.balance)}`);

    const errors = errorsSince(start);
    if(errors.length) return fail(`\n    ${errors.join('\n    ')}`);
    pass('');
  },

  /*
    The site owner's flow, against Stripe: credits were spent on something that never arrived, so the
    purchase can only be refunded for what is left; an administrator puts the spent credits back by
    reversing that spend on the buyer's ledger, and the rest becomes refundable. Both refunds are real
    ones at Stripe, made from the purchase's Refund panel, and the credits come back when kempo-payments
    fires payment:refunded.
  */
  'a refund from Credits gives back only what the buyer still holds, and the rest once it is put back': async ({ pass, fail }) => {
    if(!stripe) return pass(NO_STRIPE);

    await spendCredits({ userId: state.ids.buyer, amount: 200, reason: 'boost', reference: { owner: 'browser-suite', ref: 'boost-1' }, idempotencyKey: 'browser-suite-boost-1' });
    const mine = await call(state.server.base, 'GET', '/credits/api/my/purchases', { token: state.tokens.buyer });
    const paid = mine.data.purchases.find(purchase => purchase.status === 'paid');
    if(!paid) return fail('no paid purchase to refund');

    const page = await newPage('admin');
    const purchases = page.locator('k-cred-purchases');
    const openPurchase = async () => {
      await page.goto(`${state.server.base}/admin/extension/kempo-credits/?tab=purchases&purchase=${paid.id}`);
      await purchases.getByText('What the buyer was shown').waitFor();
    };
    const refundAll = async (expected, reason) => {
      await purchases.getByText(`up to ${expected}`).waitFor();
      await purchases.getByRole('button', { name: 'Refund…' }).click();
      await purchases.getByLabel('Why (required)').fill(reason);
      await purchases.getByRole('button', { name: 'Refund', exact: true }).click();
      await purchases.getByText(`Refunded ${expected}.`).waitFor({ timeout: 30000 });
    };
    const balance = async total => poll(async () => {
      const { data } = await call(state.server.base, 'GET', '/credits/api/my/balance', { token: state.tokens.buyer });
      return data.balance.total === total ? data.balance : null;
    });

    // 300 of the 500 credits are left, so $2.99 of $4.99 can go back.
    await openPurchase();
    await shot(page, 'admin-refund-partial');
    await refundAll('$2.99', 'Unused credits');
    if(!await balance(0)) return fail('the 300 unspent credits were not taken back');

    await openPurchase();
    await purchases.getByText('All of its credits have been spent').waitFor();
    await shot(page, 'admin-refund-blocked');

    // The boost never ran: put its 200 credits back where they came from.
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/?user=${state.ids.buyer}`);
    const account = page.locator('k-cred-account');
    await account.getByRole('button', { name: 'Reverse' }).first().click();
    await account.getByLabel('Why (required').fill('The boost never ran');
    await account.locator('form').getByRole('button', { name: 'Reverse' }).click();
    await account.getByText('Done.').waitFor();
    if(!await balance(200)) return fail('reversing the spend did not give the 200 credits back');

    await openPurchase();
    await refundAll('$2.00', 'The boost never ran');
    const finalBalance = await balance(0);
    if(!finalBalance || finalBalance.owed !== 0) return fail(`ended at ${JSON.stringify(finalBalance)}`);

    const after = await call(state.server.base, 'GET', `/credits/api/purchases/${paid.id}`, { token: state.tokens.admin });
    const { purchase, payment } = after.data;
    if(purchase.status !== 'refunded' || purchase.shortfall !== 0 || payment.amountRefunded !== 499) {
      return fail(`purchase ${purchase.status}, shortfall ${purchase.shortfall}, ${payment.amountRefunded} refunded at Stripe`);
    }
    await page.reload();
    await purchases.getByText('$4.99 refunded · 500 credits taken back').waitFor();
    await shot(page, 'admin-refund-done');
    await page.context().close();
    pass('$2.99, then $2.00 once the spend was reversed; nothing owed');
  },

  'with kempo-tax installed, the buyer gives an address and pays the tax as well': async ({ pass, fail }) => {
    if(!stripe) return pass(NO_STRIPE);

    const installed = await call(state.server.base, 'POST', '/kempo/api/extensions', { token: state.tokens.admin, body: { name: 'kempo-tax' } });
    if(installed.status !== 200) return fail(`installing kempo-tax: ${installed.status} ${JSON.stringify(installed.data)}`);
    await setSetting('kempo-tax', 'provider', 'rates', 'string', false, null);
    await setSetting('kempo-tax', 'prices_include_tax', false, 'boolean', false, null);
    const tax = await import('kempo-tax/sdk');
    await tax.createRate({ country: 'US', state: 'VT', rate: '6', taxClass: '*', label: 'Vermont' });

    const page = await newPage('member');
    await page.goto(`${state.server.base}/credits/`);
    const buy = page.locator('k-cred-buy');
    await buy.getByText('Billing address').waitFor();
    await buy.getByLabel('State or region').fill('VT');
    await buy.getByLabel('Postal code').fill('05401');
    await buy.getByLabel('City').fill('Burlington');
    await buy.getByRole('button', { name: 'Continue' }).click();
    await buy.getByText('$0.30').waitFor({ timeout: 20000 });
    await buy.getByText('$5.29').first().waitFor();
    await shot(page, 'buy-taxed');

    await fillCard(page, '4242424242424242');
    await buy.getByRole('button', { name: 'Pay $5.29' }).click();
    await buy.getByText('500 credits added').waitFor({ timeout: 90000 });
    await page.context().close();

    const mine = await call(state.server.base, 'GET', '/credits/api/my/purchases', { token: state.tokens.member });
    const taxed = mine.data.purchases.find(purchase => purchase.status === 'paid');
    const detail = await call(state.server.base, 'GET', `/credits/api/purchases/${taxed.id}`, { token: state.tokens.admin });
    if(detail.data.payment.amountCaptured !== 529) return fail(`Stripe took ${detail.data.payment.amountCaptured}, not 529`);
    if(!detail.data.purchase.taxTransactionId) return fail(`the sale is not in the tax ledger: ${detail.data.purchase.taxError}`);
    pass('charged $5.29 at Stripe and recorded in kempo-tax');
  },

  /*
    The Payments screen's own Refund button, for a purchase whose credits are partly spent. From
    kempo-payments 0.1.10 its guard refuses it; on an earlier kempo-payments, which this suite may be
    running against, it goes through, and the buyer owes exactly what it could not take back — the
    same as a refund made in Stripe's dashboard.
  */
  'a refund from the Payments screen cannot take back spent credits either': async ({ pass, fail }) => {
    if(!stripe) return pass(NO_STRIPE);

    const mine = await call(state.server.base, 'GET', '/credits/api/my/purchases', { token: state.tokens.member });
    const taxed = mine.data.purchases.find(purchase => purchase.status === 'paid');
    if(!taxed) return fail('no paid purchase from the tax case');
    const [, before] = await getBalance({ userId: state.ids.member });
    await spendCredits({ userId: state.ids.member, amount: before.promo + 20, reason: 'boost', reference: { owner: 'browser-suite', ref: 'boost-2' }, idempotencyKey: 'browser-suite-boost-2' });

    const detail = await call(state.server.base, 'GET', `/credits/api/purchases/${taxed.id}`, { token: state.tokens.admin });
    const refund = await call(state.server.base, 'POST', `/payments/api/payments/${detail.data.payment.id}/refund`, { token: state.tokens.admin, body: { reason: 'browser suite' } });

    if(refund.status === 409){
      if(!/spent/.test(refund.data.error)) return fail(`refused, but not by the credits guard: ${refund.data.error}`);
      return pass('refused by the guard');
    }
    if(refund.status !== 200) return fail(`the refund failed: ${refund.status} ${JSON.stringify(refund.data)}`);

    const owed = await poll(async () => {
      const { data } = await call(state.server.base, 'GET', '/credits/api/my/balance', { token: state.tokens.member });
      return data.balance.owed === 20 ? data.balance : null;
    });
    if(!owed) return fail('the 20 spent credits it could not take back are not owed');
    const after = await call(state.server.base, 'GET', `/credits/api/purchases/${taxed.id}`, { token: state.tokens.admin });
    if(after.data.purchase.shortfall !== 20) return fail(`the purchase records a shortfall of ${after.data.purchase.shortfall}`);

    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/?tab=purchases&purchase=${taxed.id}`);
    await page.locator('k-cred-purchases').getByText('had already been spent').waitFor();
    await shot(page, 'admin-purchase-owing');
    await page.context().close();
    pass('kempo-payments without the guard: refunded, and the 20 spent credits are owed');
  },

  /*
    Declines reach this extension only through kempo-payments' webhook, so this one needs Stripe's
    CLI forwarding events to the suite's site. Three different test cards are used so each decline
    has its own message: kempo-payments before 0.1.10 reports only declines whose message changed,
    and this suite runs against the published release.
  */
  'three declines stop the buyer, and the payment is cancelled at Stripe': async ({ pass, fail }) => {
    if(!stripe) return pass(NO_STRIPE);

    state.stripe = await forwardStripe({ apiKey: secretKey, url: `${state.server.base}/payments/api/webhooks/stripe` });
    if(!state.stripe) return pass('skipped: the Stripe CLI is not installed or could not listen');
    await setSetting('kempo-payments', 'stripe_webhook_secret', state.stripe.secret, 'secret', false, 'Stripe webhook signing secret');

    const page = await newPage('decliner');
    await page.goto(`${state.server.base}/credits/`);
    const buy = page.locator('k-cred-buy');
    await buy.getByLabel('State or region').fill('NH');
    await buy.getByRole('button', { name: 'Continue' }).click();
    await buy.getByText('Refunds:').waitFor({ timeout: 20000 });

    for(const [card, message] of [['4000000000000002', /declined/i], ['4000000000009995', /insufficient funds/i], ['4000000000000069', /expired/i]]){
      await fillCard(page, card);
      await buy.getByRole('button', { name: /^Pay / }).click();
      await buy.getByText(message).waitFor({ timeout: 30000 });
    }
    await shot(page, 'buy-declined');

    const blocked = await poll(async () => {
      const { data } = await call(state.server.base, 'GET', `/credits/api/purchases?userId=${state.ids.decliner}`, { token: state.tokens.admin });
      return data.purchases.find(purchase => purchase.status === 'blocked') || null;
    }, 60000);
    if(!blocked) return fail('the purchase was never blocked after three declines');
    if(blocked.failures !== 3 || blocked.blockedReason !== 'user-declines') return fail(`blocked with ${blocked.failures} failures for ${blocked.blockedReason}`);

    const cancelled = await poll(async () => {
      const { data } = await call(state.server.base, 'GET', `/credits/api/purchases/${blocked.id}`, { token: state.tokens.admin });
      return data.payment.status === 'canceled' ? data.payment : null;
    }, 30000);
    if(!cancelled) return fail('the payment was not cancelled at Stripe');

    await buy.getByRole('button', { name: 'Choose a different pack' }).click();
    await buy.getByRole('button', { name: 'Continue' }).click();
    await buy.getByText('Too many declined payments on this account').waitFor();
    await shot(page, 'buy-cooldown');
    await page.context().close();
    pass('');
  },

  'the browser is closed and the suite’s own processes stopped': async ({ pass }) => {
    await state.browser?.close();
    state.stripe?.child.kill();
    stopServer(state.server);

    const { kempoTaxEntry, kempoTaxQuote, kempoTaxRate } = await import(new URL('../node_modules/kempo-tax/server/db/schema.js', import.meta.url).href);
    for(const table of [kempoTaxEntry, kempoTaxQuote, kempoTaxRate]) await db.delete(table).catch(() => {});
    for(const name of ['provider', 'prices_include_tax']) await deleteSetting('kempo-tax', name).catch(() => {});
    for(const name of ['stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret']) await deleteSetting('kempo-payments', name).catch(() => {});
    await purgeSite();
    await purge();
    await purgePayments();
    pass(`screenshots in ${screensDir}`);
  },
};

/*
  A case that throws — a locator that timed out, usually — leaves a screenshot of where it got to,
  named after the case, and its page is closed so the next case starts clean.
*/
const guarded = Object.fromEntries(Object.entries(tests).map(([name, run], index) => [name, async helpers => {
  try {
    return await run(helpers);
  } catch(error) {
    if(state.page && !state.page.isClosed()){
      await shot(state.page, `failed-${index + 1}`).catch(() => {});
      await state.page.context().close().catch(() => {});
    }
    return helpers.fail(`${error.message.split('\n')[0]} — screenshot: failed-${index + 1}.png`);
  }
}]));

export default integrationTier ? guarded : integrationOnly('browser');
