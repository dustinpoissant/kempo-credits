import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/*
  The icons this extension ships are used by path (`icon-src`, `<k-icon src>`), so a typo or a file left
  behind is not caught by anything until a button renders with a gap where its glyph should be.

    /credits/icons/<name>.svg                       is  public/icons/<name>.svg   (the site, and the admin)
    /admin/extension/kempo-credits/icons/<name>.svg   is  admin/icons/<name>.svg    (the admin only)
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const walk = async dir => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for(const entry of entries){
    if(entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) files.push(...await walk(full));
    else if(/\.(js|html|json)$/.test(entry.name)) files.push(full);
  }
  return files;
};

const PATHS = /\/(?:credits\/icons|admin\/extension\/kempo-credits\/icons)\/([\w-]+)\.svg/g;

const toFile = address => address.startsWith('/admin/extension/')
  ? path.join(root, 'admin', 'icons', path.basename(address))
  : path.join(root, 'public', 'icons', path.basename(address));

export default {
  'every icon file this extension points at exists where its path says': async ({ pass, fail }) => {
    const missing = [];
    let count = 0;
    for(const file of [...await walk(path.join(root, 'admin')), ...await walk(path.join(root, 'public')), path.join(root, 'kempo-config.json')]){
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      for(const [address] of text.matchAll(PATHS)){
        count++;
        try {
          await readFile(toFile(address));
        } catch {
          missing.push(`${address} (${path.relative(root, file)})`);
        }
      }
    }
    if(missing.length) return fail(missing.join('; '));
    pass(`${count} icon paths, all present`);
  },

  'every icon file is a Material Symbols glyph that k-icon can recolour, and is used': async ({ pass, fail }) => {
    const sources = (await Promise.all([...await walk(path.join(root, 'admin')), ...await walk(path.join(root, 'public'))].map(file => readFile(file, 'utf8')))).join('\n');
    const problems = [];
    for(const folder of ['admin', 'public']){
      let names;
      try {
        names = (await readdir(path.join(root, folder, 'icons'))).filter(name => name.endsWith('.svg'));
      } catch {
        continue;
      }
      for(const name of names){
        const svg = await readFile(path.join(root, folder, 'icons', name), 'utf8');
        if(!/viewBox="0 (-960|0) 960 960"/.test(svg) || (svg.match(/<path/g) ?? []).length !== 1 || /stroke=/.test(svg)){
          problems.push(`${folder}/icons/${name}: not a single filled Material Symbols path (k-icon forces fill and drops width and height)`);
        }
        const address = folder === 'admin' ? `/admin/extension/kempo-credits/icons/${name}` : `/credits/icons/${name}`;
        if(!sources.includes(address)) problems.push(`${folder}/icons/${name}: nothing uses it`);
      }
    }
    if(problems.length) return fail(problems.join('; '));
    pass('');
  },
};
