import { spawn } from 'child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { eq, inArray } from 'drizzle-orm';
import { addUserToGroup, createUser } from 'kempo/server/sdk.js';
import { dashboardWidget, extension, group, groupPermission, hook, permission, session, user, userGroup } from 'kempo/server/db/schema.js';
import { db, seedDatabase } from './db.js';

/*
  A real kempo site with this extension installed, for the browser suite.

  It is built under tests/.tmp-site from scratch on every run: kempo's own starter site as the public
  directory, and a node_modules holding *copies* of this package and of whatever it works with, which
  is where kempo looks for extensions. Copies, never links — a link inside a directory that gets
  deleted is how a real checkout gets deleted with it. Everything else (kempo, kempo-server,
  kempo-ui, kempo-css) resolves up the directory tree to this repository's own node_modules.

  The server is this suite's own child process, on a random port, against the integration tier's
  throwaway database. The suite starts it and stops it; it is never a server anybody browses.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const siteDir = path.join(root, 'tests', '.tmp-site');
export const screensDir = path.join(siteDir, 'screens');
const modules = path.join(root, 'node_modules');

const PACKAGE_FILES = ['admin', 'hooks', 'public', 'server', 'install.js', 'update.js', 'uninstall.js', 'sdk.js', 'kempo-config.json', 'package.json'];

/*
  `own` is the package under test, copied from this checkout; `others` are packages it works with,
  copied from this checkout's node_modules (so a sibling is exactly the release, or the local build,
  that was installed there).
*/
export const buildSite = async ({ own, others = [] }) => {
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(path.join(siteDir, 'node_modules', own), { recursive: true });
  await mkdir(screensDir, { recursive: true });

  await cp(path.join(modules, 'kempo', 'app-public'), path.join(siteDir, 'public'), { recursive: true });

  /*
    kempo-ui's shadow components fetch kempo-css from a CDN unless told where it is. A suite that
    needs somebody else's server to be up is a suite that fails, or looks wrong in its screenshots,
    for reasons that have nothing to do with the code — so it is pointed at the copy this repository
    has installed, which the site already serves.
  */
  await writeFile(path.join(siteDir, 'public', 'init.js'), [
    `window.kempo = { pathsToIcons: ['/icons', '/kempo/icons', '/kempo-ui/icons'], pathToStylesheet: '/kempo-css/kempo.min.css' };`,
    'window.litDisableBundleWarning = true;',
    '',
  ].join('\n'));
  for(const entry of PACKAGE_FILES){
    if(existsSync(path.join(root, entry))) await cp(path.join(root, entry), path.join(siteDir, 'node_modules', own, entry), { recursive: true });
  }
  for(const name of others){
    await cp(path.join(modules, name), path.join(siteDir, 'node_modules', name), { recursive: true });
  }

  /*
    kempo's starter config points at ../node_modules, relative to the public directory. Here the
    shared packages are three directories further up, in this repository.
  */
  const config = JSON.parse(await readFile(path.join(modules, 'kempo', 'app-public', '.config.json'), 'utf8'));
  const up = value => value.replace(/^\.\.\/node_modules\//, '../../../node_modules/');
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

/*
  Back to a database none of the packages has been installed on: none of the suite's users, no
  extension rows or hooks, and none of those packages' permissions or groups. The last part matters
  because installers that give a permission out only on a *first* install read a leftover as a
  reinstall on a site that may have taken it away.
*/
export const purgeSite = async ({ users = {}, extensions = [] } = {}) => {
  const emails = Object.values(users).map(account => account.email);
  const rows = emails.length ? await db.select({ id: user.id }).from(user).where(inArray(user.email, emails)) : [];
  const ids = rows.map(row => row.id);
  if(ids.length){
    await db.delete(session).where(inArray(session.userId, ids));
    await db.delete(userGroup).where(inArray(userGroup.userId, ids));
    await db.delete(user).where(inArray(user.id, ids));
  }

  for(const name of extensions){
    await db.delete(hook).where(eq(hook.owner, name));
    await db.delete(dashboardWidget).where(eq(dashboardWidget.owner, name));
    await db.delete(extension).where(eq(extension.name, name));

    const file = path.join(root, 'kempo-config.json');
    const own = JSON.parse(await readFile(file, 'utf8'));
    const config = own.git?.endsWith(`/${name}`)
      ? own
      : JSON.parse(await readFile(path.join(modules, name, 'kempo-config.json'), 'utf8').catch(() => '{}'));

    const permissions = (config.permissions || []).map(entry => entry.name);
    const groups = (config.groups || []).map(entry => entry.name);
    if(groups.length){
      await db.delete(userGroup).where(inArray(userGroup.groupName, groups));
      await db.delete(groupPermission).where(inArray(groupPermission.groupName, groups));
      await db.delete(group).where(inArray(group.name, groups));
    }
    if(permissions.length){
      await db.delete(groupPermission).where(inArray(groupPermission.permissionName, permissions));
      await db.delete(permission).where(inArray(permission.name, permissions));
    }
  }
};

/*
  The system groups and permissions, then the people. Groups that belong to an extension are added
  after it is installed, since installing is what creates them.
*/
export const seedPeople = async users => {
  await seedDatabase();
  const ids = {};
  for(const [key, account] of Object.entries(users)){
    const [error, created] = await createUser({ name: account.name, email: account.email, password: account.password, emailVerified: true });
    if(error) throw new Error(`could not create ${key}: ${error.msg}`);
    ids[key] = created.user.id;
    for(const name of (account.groups || []).filter(entry => entry.startsWith('system:'))) await addUserToGroup(created.user.id, name);
  }
  return ids;
};

export const joinExtensionGroups = async (users, ids) => {
  for(const [key, account] of Object.entries(users)){
    for(const name of (account.groups || []).filter(entry => !entry.startsWith('system:'))){
      const [error] = await addUserToGroup(ids[key], name);
      if(error) throw new Error(`could not add ${key} to ${name}: ${error.msg}`);
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
