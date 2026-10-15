import path from 'path';
import { eq } from 'drizzle-orm';
import { groupPermission, permission } from 'kempo/server/db/schema.js';
import { getBalance } from '../server/utils/ledger/read.js';
import grantCredits from '../server/utils/ledger/grant.js';
import { db, integrationOnly, integrationTier } from './helpers/db.js';
import { purge } from './helpers/ledger.js';
import {
  buildSite, call, joinExtensionGroups, login, purgeSite, screensDir, seedPeople, startServer, stopServer,
} from './helpers/site.js';

/*
  The extension in a real browser, on a real kempo site, through every screen.

  A throwaway site is built and served by this suite (see helpers/site.js); kempo-credits is
  installed into it through kempo's own install route, the way an administrator would. Chromium is
  driven by Playwright. Each screen is opened, used, and checked for console errors, and a
  screenshot of each is saved to tests/.tmp-site/screens.

  The HTTP contract — who may reach which route — is checked over plain HTTP for every audience:
  nobody, a member, the support group and an administrator.

  Integration tier only: it needs a real Postgres and a second server process.
*/

const USERS = {
  admin: { name: 'Credits Admin', email: 'credits-admin@test.local', password: 'CreditsAdmin123!', groups: ['system:Administrators'] },
  support: { name: 'Credits Support', email: 'credits-support@test.local', password: 'CreditsSupport123!', groups: ['kempo-credits:support'] },
  alice: { name: 'Alice Member', email: 'credits-alice@test.local', password: 'CreditsAlice123!', groups: [] },
  bob: { name: 'Bob Member', email: 'credits-bob@test.local', password: 'CreditsBob12345!', groups: [] },
};

const state = { server: null, browser: null, tokens: {}, ids: {}, errors: [], page: null };

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

const tab = async (page, name) => {
  await page.locator(`k-tab[for="${name}"]`).click();
  await page.waitForTimeout(400);
};

const tests = {
  'a site boots and kempo-credits installs through kempo’s own route': async ({ pass, fail }) => {
    await purgeSite({ users: USERS, extensions: ['kempo-credits'] });
    await purge();
    await buildSite({ own: 'kempo-credits' });
    state.ids = await seedPeople(USERS);
    state.server = await startServer();

    state.tokens.admin = await login(state.server.base, USERS.admin);
    if(!state.tokens.admin) return fail('the administrator could not sign in');

    const installed = await call(state.server.base, 'POST', '/kempo/api/extensions', { token: state.tokens.admin, body: { name: 'kempo-credits' } });
    if(installed.status !== 200) return fail(`installing: ${installed.status} ${JSON.stringify(installed.data)}`);

    await joinExtensionGroups(USERS, state.ids);
    for(const who of ['support', 'alice', 'bob']){
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
      ['GET', '/credits/api/my/balance', null, 401],
      ['GET', '/credits/api/my/balance', 'alice', 200],
      ['GET', '/credits/api/my/entries', 'alice', 200],
      ['POST', '/credits/api/my/transfers', null, 401],
      ['POST', '/credits/api/my/transfers', 'alice', 403],
      ['GET', '/credits/api/accounts', null, 401],
      ['GET', '/credits/api/accounts', 'alice', 403],
      ['GET', '/credits/api/accounts', 'support', 200],
      ['GET', '/credits/api/accounts', 'admin', 200],
      ['GET', '/credits/api/summary', 'alice', 403],
      ['GET', '/credits/api/summary', 'support', 200],
      ['POST', `/credits/api/accounts/${encodeURIComponent('someone')}/grant`, 'alice', 403],
      ['POST', `/credits/api/accounts/${encodeURIComponent('someone')}/remove`, 'support', 403],
      ['POST', `/credits/api/accounts/${encodeURIComponent('someone')}/forgive`, 'support', 403],
      ['POST', '/credits/api/lots/lot_x/claw-back', 'support', 403],
      ['POST', '/credits/api/operations/op_x/reverse', 'support', 403],
      ['GET', '/credits/api/settings', 'support', 403],
      ['GET', '/credits/api/settings', 'admin', 200],
      ['PUT', '/credits/api/settings', 'support', 403],
      ['GET', '/credits/api/packs', null, 404],
      ['GET', '/credits/api/claims', 'admin', 404],
      ['GET', '/admin/extension/kempo-credits/', null, 302],
      ['GET', '/admin/extension/kempo-credits/', 'alice', 302],
      ['GET', '/admin/extension/kempo-credits/', 'admin', 200],
      ['GET', '/admin/extension/kempo-credits/account/', null, 302],
      ['GET', '/admin/extension/kempo-credits/account/', 'member', 302],
      ['GET', '/admin/extension/kempo-credits/account/', 'support', 200],
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

    for(const name of ['balances', 'grant', 'settings']){
      await tab(page, name);
      if(!await page.locator(`k-tab-content[name="${name}"]`).isVisible()) return fail(`the ${name} tab did not open`);
      await shot(page, `admin-${name}`);
    }
    if(await page.locator('k-tab[for="purchases"], k-tab[for="packs"], k-tab[for="claims"]').count()) return fail('a purchase, pack or claim tab is on the credits screen');

    await page.context().close();
    const errors = state.errors.slice(start);
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

  'an administrator gives and takes credits from a member’s ledger, and the audit holds': async ({ pass, fail }) => {
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/extension/kempo-credits/account/?user=${state.ids.alice}`);
    const account = page.locator('k-cred-account');
    await account.getByText('Alice Member').waitFor();

    await account.getByRole('button', { name: 'Give credits' }).first().click();
    await account.getByLabel('Credits', { exact: true }).fill('150');
    await account.getByLabel('Why').fill('Welcome bonus');
    await account.locator('form').getByRole('button', { name: 'Give credits' }).click();
    await account.getByText('Done.').waitFor();

    await account.getByRole('button', { name: 'Take credits away' }).click();
    await account.getByLabel('Credits', { exact: true }).fill('20');
    await account.getByLabel('Why').fill('Granted twice by mistake');
    await account.getByRole('button', { name: 'Take them away' }).click();
    await account.getByText('Done.').waitFor();

    const balance = await call(state.server.base, 'GET', '/credits/api/my/balance', { token: state.tokens.alice });
    if(balance.data?.balance?.total !== 130) return fail(`alice has ${balance.data?.balance?.total}, expected 150 - 20`);

    await account.getByText('The ledger proves this balance').waitFor();
    await account.getByText('Welcome bonus').first().waitFor();
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
    for(const name of ['balances', 'grant', 'settings']) visible[name] = await page.locator(`k-tab[for="${name}"]`).isVisible();
    if(JSON.stringify(visible) !== JSON.stringify({ balances: true, grant: true, settings: false })) return fail(`tabs visible: ${JSON.stringify(visible)}`);

    await page.goto(`${state.server.base}/admin/extension/kempo-credits/account/?user=${state.ids.alice}`);
    const account = page.locator('k-cred-account');
    await account.getByText('Alice Member').waitFor();
    if(!await account.getByRole('button', { name: 'Give credits' }).count()) return fail('support cannot give credits');
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

    await settings.getByLabel('Kinds that cannot be sent').fill('purchase, Ad-Reward');
    await settings.getByRole('button', { name: 'Save' }).click();
    await settings.getByText('Saved.').waitFor();

    const saved = await call(state.server.base, 'GET', '/credits/api/settings', { token: state.tokens.admin });
    const kinds = saved.data.settings.find(setting => setting.name === 'non_transferable_kinds');
    if(kinds.value !== 'purchase,ad-reward') return fail(`saved as ${JSON.stringify(kinds.value)}`);
    await settings.getByLabel('Kinds that cannot be sent').fill('');
    await settings.getByRole('button', { name: 'Save' }).click();
    await settings.getByText('Saved.').waitFor();
    await shot(page, 'admin-settings-saved');

    const typo = await call(state.server.base, 'PUT', '/credits/api/settings', { token: state.tokens.admin, body: { low_balance_treshold: 3 } });
    if(typo.status !== 400) return fail(`a misspelt setting gave ${typo.status}`);
    const badKind = await call(state.server.base, 'PUT', '/credits/api/settings', { token: state.tokens.admin, body: { non_transferable_kinds: 'Has Space' } });
    if(badKind.status !== 400) return fail(`an invalid kind gave ${badKind.status}`);
    await page.context().close();
    pass('');
  },

  'nobody can send credits until the site gives a group the permission': async ({ pass, fail }) => {
    const page = await newPage('alice');
    await page.goto(`${state.server.base}/credits/`);
    await page.locator('k-cred-balance').getByText('130').waitFor();
    await page.waitForTimeout(500);
    if(await page.locator('#send-section').isVisible()) return fail('the send form is offered to somebody who cannot use it');
    await shot(page, 'wallet-no-send');
    await page.context().close();

    const refused = await call(state.server.base, 'POST', '/credits/api/my/transfers', {
      token: state.tokens.alice, body: { toEmail: USERS.bob.email, amount: 10, idempotencyKey: 'x' },
    });
    if(refused.status !== 403) return fail(`sending without the permission gave ${refused.status}`);
    pass('');
  },

  'a member sends credits to another from their credits page': async ({ pass, fail }) => {
    // What a site does on purpose: give members the permission.
    await db.insert(permission).values({ name: 'credits:transfer', description: 'x', owner: 'kempo-credits', createdAt: new Date() }).onConflictDoNothing();
    await db.insert(groupPermission).values({
      id: 'browser-suite-transfer', groupName: 'system:Users', permissionName: 'credits:transfer', createdAt: new Date(),
    }).onConflictDoNothing();

    const start = state.errors.length;
    const page = await newPage('alice');
    await page.goto(`${state.server.base}/credits/`);
    const send = page.locator('k-cred-send');
    await send.getByLabel('Their email address').fill(USERS.bob.email);
    await send.getByLabel('Credits', { exact: true }).fill('45');
    await send.getByLabel('Message').fill('Thanks for the help');
    await shot(page, 'wallet-send');
    await send.getByRole('button', { name: 'Send credits' }).click();
    await send.getByText('Sent 45 credits to Bob Member').waitFor();

    await page.locator('k-cred-balance').getByText('85').waitFor();
    await page.locator('k-cred-history').getByText('Sent to Bob Member').waitFor();
    await shot(page, 'wallet-sent');
    await page.context().close();

    const bobPage = await newPage('bob');
    await bobPage.goto(`${state.server.base}/credits/`);
    await bobPage.locator('k-cred-balance').getByText('45').waitFor();
    await bobPage.locator('k-cred-history').getByText('Received from Alice Member').waitFor();
    await shot(bobPage, 'wallet-received');
    await bobPage.context().close();

    const [, balance] = await getBalance({ userId: state.ids.bob });
    if(balance.total !== 45) return fail(`bob has ${balance.total}`);
    const errors = state.errors.slice(start);
    if(errors.length) return fail(`\n    ${errors.join('\n    ')}`);
    pass('');
  },

  'sending is refused for a user that does not exist, yourself, and more than you have': async ({ pass, fail }) => {
    const send = body => call(state.server.base, 'POST', '/credits/api/my/transfers', { token: state.tokens.alice, body: { idempotencyKey: crypto.randomUUID(), amount: 1, ...body } });

    const stranger = await send({ toEmail: 'nobody@test.local' });
    if(stranger.status !== 404) return fail(`an unknown address gave ${stranger.status}`);
    const myself = await send({ toUserId: state.ids.alice });
    if(myself.status !== 400) return fail(`sending to yourself gave ${myself.status}`);
    const tooMuch = await send({ toUserId: state.ids.bob, amount: 100000 });
    if(tooMuch.status !== 402 || tooMuch.data.balance !== 85) return fail(`more than they hold gave ${tooMuch.status} ${JSON.stringify(tooMuch.data)}`);
    const noKey = await call(state.server.base, 'POST', '/credits/api/my/transfers', { token: state.tokens.alice, body: { toUserId: state.ids.bob, amount: 1 } });
    if(noKey.status !== 400) return fail(`no idempotency key gave ${noKey.status}`);

    const twice = crypto.randomUUID();
    const first = await send({ toUserId: state.ids.bob, idempotencyKey: twice, amount: 5 });
    const second = await send({ toUserId: state.ids.bob, idempotencyKey: twice, amount: 5 });
    if(first.status !== 200 || second.status !== 200 || !second.data.duplicate) return fail(`a retry: ${first.status}, ${second.status}`);
    const mine = await call(state.server.base, 'GET', '/credits/api/my/balance', { token: state.tokens.alice });
    if(mine.data.balance.total !== 80) return fail(`alice has ${mine.data.balance.total} after sending 5 twice under one key`);

    if(JSON.stringify(first.data).includes(USERS.bob.email)) return fail('the response gave the recipient’s email address back');
    pass('');
  },

  'the dashboard widget shows the credits held': async ({ pass, fail }) => {
    const start = state.errors.length;
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/`);
    await page.locator('k-cred-widget').getByText('Credits held').waitFor({ timeout: 20000 });
    await shot(page, 'admin-dashboard');
    await page.context().close();
    const errors = state.errors.slice(start);
    if(errors.length) return fail(`\n    ${errors.join('\n    ')}`);
    pass('');
  },

  'a grant made from code shows in the member’s history with its reason': async ({ pass, fail }) => {
    await grantCredits({
      userId: state.ids.bob, amount: 15, kind: 'ad-reward', reason: 'Watched an ad',
      reference: { owner: 'browser-suite', ref: 'ad-1' }, idempotencyKey: 'browser-suite-ad-1',
    });
    const page = await newPage('bob');
    await page.goto(`${state.server.base}/credits/`);
    await page.locator('k-cred-history').getByText('Watched an ad').waitFor();
    await page.locator('k-cred-balance').getByText('ad reward').waitFor();
    await shot(page, 'wallet-kinds');
    await page.context().close();
    pass('');
  },

  /*
    A user is a page of their own, so the address names them, the back button returns to the list
    and a pasted link lands on them. The old ?user= on the list page still works.
  */
  'a user is a page of their own: the address changes and the back button returns to the list': async ({ pass, fail }) => {
    const page = await newPage('admin');
    const list = `${state.server.base}/admin/extension/kempo-credits/`;
    await page.goto(list);
    const balances = page.locator('k-cred-balances');
    await balances.getByText('Credits held').waitFor();
    await balances.getByPlaceholder(/Find a user/).fill('Alice');
    await balances.getByRole('link', { name: 'Alice Member' }).click();
    await page.waitForURL(/account\/\?user=/);
    await page.locator('k-cred-account').getByText('Alice Member').first().waitFor();
    if(!page.url().includes(state.ids.alice)) return fail(`the address does not name the user: ${page.url()}`);

    await page.goBack();
    await page.waitForURL(list);
    await page.locator('k-cred-balances').getByText('Credits held').waitFor();

    await page.goto(`${list}?user=${state.ids.alice}`);
    await page.waitForURL(/account\/\?user=/);

    await page.getByRole('link', { name: 'Credits' }).first().click();
    await page.waitForURL(list);
    await page.context().close();
    pass('');
  },

  'the browser is closed and the site’s server stopped': async ({ pass }) => {
    await state.browser?.close();
    stopServer(state.server);
    await db.delete(groupPermission).where(eq(groupPermission.id, 'browser-suite-transfer'));
    await purgeSite({ users: USERS, extensions: ['kempo-credits'] });
    await purge();
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
