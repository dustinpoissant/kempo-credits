import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/*
  The only thing a scaffold can be wrong about: that its plan is there and its config parses.
  Replace this file's checks as real code lands — do not delete the plan check, an agent working
  here is meant to be able to find it.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default {
  'the plan is present and names the package': async ({ pass, fail }) => {
    const plan = await readFile(path.join(root, 'PLAN.md'), 'utf8');
    if(!plan.includes('kempo-credits')) return fail('PLAN.md does not mention the package name');
    pass('');
  },

  'kempo-config.json parses and declares a public scope': async ({ pass, fail }) => {
    const config = JSON.parse(await readFile(path.join(root, 'kempo-config.json'), 'utf8'));
    if(config['public-scope'] !== 'credits') return fail('public-scope should be "credits"');
    pass('');
  },
};
