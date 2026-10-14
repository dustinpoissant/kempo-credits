import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../server/db/schema.js';
import { INDEXES } from '../server/db/indexes.js';
import { DEFAULTS, NORMALISE, SETTING_NAMES } from '../server/utils/config/settings.js';
import { VALIDATORS } from '../server/utils/config/validate.js';

/*
  Static checks that what the code asks for is what the extension declares.

  A permission checked by a route but never declared does not error — it answers "no", forever, for
  everyone but administrators, which is exactly why it survives testing by an administrator. A
  setting read but never declared silently uses its default. An index the schema declares but
  install.js forgets exists only on a developer's database, where `drizzle-kit push` made it. Each
  of those has a check here.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(root, file), 'utf8');
const config = JSON.parse(await read('kempo-config.json'));
const pkg = JSON.parse(await read('package.json'));

const walk = async (dir, match) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for(const entry of entries){
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) files.push(...await walk(full, match));
    else if(match(entry.name)) files.push(full);
  }
  return files;
};

const sources = [
  ...await walk(path.join(root, 'public'), name => /\.(js|html)$/.test(name)),
  ...await walk(path.join(root, 'server'), name => name.endsWith('.js')),
  ...await walk(path.join(root, 'admin'), name => /\.(js|html)$/.test(name)),
];
const contents = new Map(await Promise.all(sources.map(async file => [file, await readFile(file, 'utf8')])));
const relative = file => path.relative(root, file).replaceAll('\\', '/');

export default {
  'the plan is present and names the package': async ({ pass, fail }) => {
    const plan = await read('PLAN.md');
    if(!plan.includes('kempo-credits')) return fail('PLAN.md does not mention the package name');
    pass('');
  },

  'every permission the code checks is declared': async ({ pass, fail }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));
    const events = new Set(['credits:granted', 'credits:spent', 'credits:reversed', 'credits:clawed-back', 'credits:low']);
    for(const [file, text] of contents){
      for(const match of text.matchAll(/['"](credits:[a-z:-]+)['"]/g)){
        if(!declared.has(match[1]) && !events.has(match[1])) return fail(`${relative(file)} uses "${match[1]}", which nothing declares`);
      }
      for(const match of text.matchAll(/has="(credits:[a-z:-]+)"/g)){
        if(!declared.has(match[1])) return fail(`${relative(file)} gates on "${match[1]}", which nothing declares`);
      }
    }
    pass(`${declared.size} permissions`);
  },

  'every declared permission is enforced by a route': async ({ pass, fail }) => {
    const routes = [...contents].filter(([file]) => relative(file).startsWith('public/api/')).map(([, text]) => text).join('\n');
    for(const { name } of config.permissions){
      if(!routes.includes(`'${name}'`)) return fail(`"${name}" is declared but no route checks it — it grants nothing`);
    }
    pass('');
  },

  'every group grants only declared permissions': async ({ pass, fail }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));
    for(const group of config.groups){
      if(!group.name.startsWith('kempo-credits:')) return fail(`group ${group.name} is not prefixed with the package name`);
      /*
        system:admin:access is kempo's own, and staff groups carry it so their members can open the
        admin at all — the same as kempo-products' and kempo-inventory's groups.
      */
      if(!group.permissions.includes('system:admin:access')) return fail(`${group.name} cannot open the admin without system:admin:access`);
      for(const permission of group.permissions.filter(name => name !== 'system:admin:access')){
        if(!declared.has(permission)) return fail(`${group.name} grants "${permission}", which is not declared`);
      }
      if(group.permissions.includes('credits:purchase')) return fail(`${group.name} grants credits:purchase, which every user already holds`);
    }
    pass('');
  },

  'every setting the code reads is declared, with the default the code assumes': async ({ pass, fail }) => {
    const declared = new Map(config.settings.map(setting => [setting.name, setting]));

    for(const [key, name] of Object.entries(SETTING_NAMES)){
      const setting = declared.get(name);
      if(!setting) return fail(`the code reads "${name}", which is not declared`);
      const asDeclared = NORMALISE[key](setting.value);
      if(asDeclared !== DEFAULTS[key]) return fail(`"${name}" is declared as ${JSON.stringify(setting.value)} but the code defaults to ${JSON.stringify(DEFAULTS[key])}`);
      const expectedType = typeof DEFAULTS[key] === 'boolean' ? 'boolean' : typeof DEFAULTS[key] === 'number' ? 'number' : 'string';
      if(setting.type !== expectedType) return fail(`"${name}" is declared as ${setting.type} but used as a ${expectedType}`);
      if(!setting.description) return fail(`"${name}" has no description`);
      if(!VALIDATORS[name]) return fail(`"${name}" cannot be saved from the settings screen`);
    }

    for(const name of declared.keys()){
      if(!Object.values(SETTING_NAMES).includes(name)) return fail(`"${name}" is declared but nothing reads it`);
    }
    pass(`${declared.size} settings`);
  },

  'install.js creates every index the schema declares, and no others': async ({ pass, fail }) => {
    const declared = new Map();
    for(const table of Object.values(schema)){
      if(!table?.[Symbol.for('drizzle:Name')]) continue;
      const { name, indexes } = getTableConfig(table);
      for(const index of indexes){
        declared.set(index.config.name, {
          table: name,
          unique: index.config.unique,
          columns: index.config.columns.map(column => column.name),
        });
      }
    }

    const created = new Map(INDEXES.map(index => [index.name, index]));
    for(const [name, index] of declared){
      const made = created.get(name);
      if(!made) return fail(`${name} is declared in the schema but install.js never creates it`);

      const text = made.sql.queryChunks.map(chunk => chunk.value?.join?.('') ?? '').join('');
      if(index.unique !== /UNIQUE/.test(text)) return fail(`${name} is ${index.unique ? '' : 'not '}unique in the schema, and the other way in install.js`);
      if(!text.includes(`ON "${index.table}" (${index.columns.map(column => `"${column}"`).join(', ')})`)) {
        return fail(`${name} covers ${index.table}(${index.columns}) in the schema, but install.js says: ${text}`);
      }
    }
    for(const name of created.keys()){
      if(!declared.has(name)) return fail(`install.js creates ${name}, which the schema does not declare`);
    }

    if(!created.get('kempoCreditEntry_idempotency_idx')?.required) return fail('the idempotency index is not required — an install without it would go ahead');
    pass(`${declared.size} indexes`);
  },

  'every route module loads and exports a handler': async ({ pass, fail }) => {
    const routes = await walk(path.join(root, 'public', 'api'), name => /^(GET|POST|PUT|DELETE|PATCH)\.js$/.test(name));
    for(const file of routes){
      try {
        const module = await import(pathToFileURL(file).href);
        if(typeof module.default !== 'function') return fail(`${relative(file)} does not export a handler`);
      } catch(error) {
        return fail(`${relative(file)} does not load: ${error.message}`);
      }
    }
    pass(`${routes.length} routes`);
  },

  'every hook, widget and page the config names exists': async ({ pass, fail }) => {
    for(const [event, callback] of Object.entries(config.hooks)){
      const module = await import(pathToFileURL(path.join(root, callback)).href).catch(error => ({ error }));
      if(module.error) return fail(`the ${event} hook (${callback}) does not load: ${module.error.message}`);
      if(typeof module.default !== 'function') return fail(`the ${event} hook does not export a handler`);
    }

    for(const widget of config.widgets){
      const file = path.join(root, 'public', widget.module.replace(/^\/credits\//, ''));
      if(!await stat(file).catch(() => null)) return fail(`widget ${widget.key} names ${widget.module}, which does not exist`);
      if(!(await readFile(file, 'utf8')).includes(`'${widget.element}'`)) return fail(`${widget.module} does not define <${widget.element}>`);
    }

    if(!await stat(path.join(root, 'admin', 'index.page.html')).catch(() => null)) return fail('there is no admin page');
    pass('');
  },

  'custom elements are prefixed k-cred-': async ({ pass, fail }) => {
    for(const [file, text] of contents){
      for(const match of text.matchAll(/customElements\.define\(\s*['"]([^'"]+)['"]/g)){
        if(!match[1].startsWith('k-cred-')) return fail(`${relative(file)} defines <${match[1]}>`);
      }
    }
    pass('');
  },

  'no HTTP-specific code in server/utils': async ({ pass, fail }) => {
    for(const [file, text] of contents){
      if(!relative(file).startsWith('server/utils/')) continue;
      if(/\b(request|response)\.(cookies|headers|body|query|params|status|json)\b/.test(text)) return fail(`${relative(file)} reads a request or writes a response`);
    }
    pass('');
  },

  'the package ships everything it needs and declares no file: specifier': async ({ pass, fail }) => {
    for(const entry of ['admin', 'hooks', 'public', 'server', 'install.js', 'update.js', 'uninstall.js', 'sdk.js', 'kempo-config.json']){
      if(!pkg.files.includes(entry)) return fail(`package.json "files" leaves out ${entry}`);
    }
    for(const field of ['dependencies', 'devDependencies', 'peerDependencies']){
      for(const [name, range] of Object.entries(pkg[field] || {})){
        if(String(range).startsWith('file:')) return fail(`${field}.${name} is ${range}`);
      }
    }
    if(!pkg.peerDependencies['kempo-payments']) return fail('kempo-payments is a hard dependency and must be a peer');
    if(!pkg.peerDependenciesMeta?.['kempo-tax']?.optional) return fail('kempo-tax must be an optional peer');
    if(!config.dependencies.includes('kempo-payments')) return fail('kempo-config.json does not require kempo-payments');
    if(config.dependencies.includes('kempo-tax')) return fail('kempo-tax is optional and must not be a required dependency');
    pass('');
  },

  'kempo-tax is never imported statically': async ({ pass, fail }) => {
    for(const [file, text] of contents){
      if(/^\s*import\s[^;]*from\s+['"]kempo-tax/m.test(text)) return fail(`${relative(file)} imports kempo-tax at load time`);
    }
    pass('');
  },
};
