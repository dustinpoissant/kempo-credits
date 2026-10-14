import { spawn } from 'child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { eq, inArray } from 'drizzle-orm';
import { addUserToGroup, createUser } from 'kempo/server/sdk.js';
import { extension, group, groupPermission, hook, permission, session, user, userGroup } from 'kempo/server/db/schema.js';
import { db, seedDatabase } from './db.js';

/*
  A real kempo site with this extension installed, for the browser suite.

  It is built under tests/.tmp-site from scratch on every run: kempo's own starter site as the public
  directory, and a node_modules holding *copies* of this package, kempo-payments and kempo-tax —
  which is where kempo looks for extensions. kempo-tax is there to be installed, not installed. Copies, never links — a link inside a
  directory that gets deleted is how a real checkout gets deleted with it. Everything else (kempo,
  kempo-server, kempo-ui, kempo-css) resolves up the directory tree to this repository's own
  node_modules.

  The server is this suite's own child process, on a random port, against the integration tier's
  throwaway database. The suite starts it and stops it; it is never a server anybody browses.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const siteDir = path.join(root, 'tests', '.tmp-site');
export const screensDir = path.join(siteDir, 'screens');
const modules = path.join(root, 'node_modules');

const PACKAGE_FILES = ['admin', 'hooks', 'public', 'server', 'install.js', 'update.js', 'uninstall.js', 'sdk.js', 'kempo-config.json', 'package.json'];

export const USERS = {
  admin: { name: 'Credits Admin', email: 'credits-admin@test.local', password: 'CreditsAdmin123!', groups: ['system:Administrators'] },
  support: { name: 'Credits Support', email: 'credits-support@test.local', password: 'CreditsSupport123!', groups: ['kempo-credits:support'] },
  member: { name: 'Credits Member', email: 'credits-member@test.local', password: 'CreditsMember123!', groups: [] },
  buyer: { name: 'Credits Buyer', email: 'credits-buyer@test.local', password: 'CreditsBuyer123!', groups: [] },
  decliner: { name: 'Credits Decliner', email: 'credits-decliner@test.local', password: 'CreditsDecliner123!', groups: [] },
};

/*
  Stripe's CLI forwarding the test account's events to the suite's site, so the webhook path runs
  for real. Null when the CLI is not installed. Like the server, it is the suite's own child process.
*/
export const forwardStripe = async ({ apiKey, url }) => {
  const events = 'payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled,payment_intent.processing,charge.refunded,charge.refund.updated,charge.dispute.created,charge.dispute.closed';

  const secret = await new Promise(resolve => {
    const probe = spawn('stripe', ['listen', '--api-key', apiKey, '--print-secret'], { shell: true });
    let output = '';
    probe.stdout.on('data', chunk => { output += chunk; });
    probe.on('error', () => resolve(null));
    probe.on('close', () => resolve(output.match(/whsec_[A-Za-z0-9]+/)?.[0] || null));
  });
  if(!secret) return null;

  const child = spawn('stripe', ['listen', '--api-key', apiKey, '--events', events, '--forward-to', url], { shell: true });
  const ready = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 30000);
    const watch = chunk => {
      if(/Ready!/.test(String(chunk))){
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
  });
  if(!ready){
    child.kill();
    return null;
  }
  return { secret, child };
};

export const buildSite = async () => {
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(path.join(siteDir, 'node_modules', 'kempo-credits'), { recursive: true });
  await mkdir(screensDir, { recursive: true });

  await cp(path.join(modules, 'kempo', 'app-public'), path.join(siteDir, 'public'), { recursive: true });
  for(const entry of PACKAGE_FILES){
    await cp(path.join(root, entry), path.join(siteDir, 'node_modules', 'kempo-credits', entry), { recursive: true });
  }
  await cp(path.join(modules, 'kempo-payments'), path.join(siteDir, 'node_modules', 'kempo-payments'), { recursive: true });
  await cp(path.join(modules, 'kempo-tax'), path.join(siteDir, 'node_modules', 'kempo-tax'), { recursive: true });

  /*
    kempo's starter config points at ../node_modules, relative to the public directory. Here the
    shared packages are three directories further up, in this repository.
  */
  const config = JSON.parse(await readFile(path.join(modules, 'kempo', 'app-public', '.config.json'), 'utf8'));
  const up = path => path.replace(/^\.\.\/node_modules\//, '../../../node_modules/');
  config.customRoutes = Object.fromEntries(Object.entries(config.customRoutes).map(([route, target]) => [route, up(target)]));
  config.middleware.custom = config.middleware.custom.map(up);
  await writeFile(path.join(siteDir, 'server.config.json'), JSON.stringify(config, null, 2));
};

const waitFor = async (url, tries = 150) => {
  for(let attempt = 0; attempt < tries; attempt++){
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  return false;
};

export const startServer = async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const output = [];
  const child = spawn(process.execPath, [
    path.join(modules, 'kempo-server', 'dist', 'index.js'),
    '--root', path.join(siteDir, 'public'),
    '--config', path.join(siteDir, 'server.config.json'),
    '--port', String(port),
  ], {
    cwd: siteDir,
    env: { ...process.env, NODE_OPTIONS: '', KEMPO_DB: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));

  const base = `http://127.0.0.1:${port}`;
  if(!await waitFor(`${base}/login`)){
    child.kill();
    throw new Error(`the site did not start on port ${port}:\n${output.join('')}`);
  }
  return { base, child, output };
};

/*
  Stops the suite's own server. It is the child process this suite spawned a few seconds earlier,
  so nothing else is using it.
*/
export const stopServer = server => {
  server?.child?.kill();
};

const emails = Object.values(USERS).map(account => account.email);

/*
  Back to a database this extension has never been installed on: no users of the suite's, no
  extension rows or hooks, and none of this extension's permissions or groups. The last part matters
  because install.js gives `credits:purchase` to everyone only on a *first* install — a permission
  left over from an earlier run reads, correctly, as a reinstall on a site that may have taken it away.
*/
export const purgeSite = async () => {
  const rows = await db.select({ id: user.id }).from(user).where(inArray(user.email, emails));
  const ids = rows.map(row => row.id);
  if(ids.length){
    await db.delete(session).where(inArray(session.userId, ids));
    await db.delete(userGroup).where(inArray(userGroup.userId, ids));
    await db.delete(user).where(inArray(user.id, ids));
  }
  for(const name of ['kempo-credits', 'kempo-payments', 'kempo-tax']){
    await db.delete(hook).where(eq(hook.owner, name));
    await db.delete(extension).where(eq(extension.name, name));
  }

  const config = JSON.parse(await readFile(path.join(root, 'kempo-config.json'), 'utf8'));
  const permissions = config.permissions.map(entry => entry.name);
  const groups = config.groups.map(entry => entry.name);
  await db.delete(userGroup).where(inArray(userGroup.groupName, groups));
  await db.delete(groupPermission).where(inArray(groupPermission.groupName, groups));
  await db.delete(groupPermission).where(inArray(groupPermission.permissionName, permissions));
  await db.delete(group).where(inArray(group.name, groups));
  await db.delete(permission).where(inArray(permission.name, permissions));
};

/*
  The system groups and permissions, then the people. Groups that belong to the extension are added
  after it is installed, since installing is what creates them.
*/
export const seedPeople = async () => {
  await seedDatabase();
  const ids = {};
  for(const [key, account] of Object.entries(USERS)){
    const [error, created] = await createUser({ name: account.name, email: account.email, password: account.password, emailVerified: true });
    if(error) throw new Error(`could not create ${key}: ${error.msg}`);
    ids[key] = created.user.id;
    for(const group of account.groups.filter(name => name.startsWith('system:'))) await addUserToGroup(created.user.id, group);
  }
  return ids;
};

export const joinExtensionGroups = async ids => {
  for(const [key, account] of Object.entries(USERS)){
    for(const group of account.groups.filter(name => !name.startsWith('system:'))){
      const [error] = await addUserToGroup(ids[key], group);
      if(error) throw new Error(`could not add ${key} to ${group}: ${error.msg}`);
    }
  }
};

export const login = async (base, account) => {
  const response = await fetch(`${base}/kempo/api/auth/login/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    redirect: 'manual',
  });
  return (response.headers.get('set-cookie') || '').match(/session_token=([^;]+)/)?.[1] || null;
};

export const call = async (base, method, url, { token, body } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(token ? { cookie: `session_token=${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
};
