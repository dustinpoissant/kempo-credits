import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import path from 'path';

/*
  Runs a command with kempo's database module pointed at an in-process Postgres (PGlite).

  This extension has no tables of its own, so there is no integration tier: the only thing the
  database is needed for is that kempo's settings module can be imported at all.

  Usage: node scripts/run-tests.js <command> [arguments]
*/

const [command, ...args] = process.argv.slice(2);

if(!command){
  console.error('Usage: node scripts/run-tests.js <command> [arguments]');
  process.exit(2);
}

const env = { ...process.env };

// A throwaway key, so the suites that store `secret` settings can run. It protects nothing.
env.SETTINGS_ENCRYPTION_KEY ||= '0'.repeat(64);
env.KEMPO_DB = 'pglite';

// Create the database before any test file can install globals that confuse it. See the preload.
const preload = pathToFileURL(path.resolve(import.meta.dirname, '..', 'tests', 'helpers', 'preload.js')).href;
env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import=${preload}`.trim();

const result = spawnSync(command, args, { stdio: 'inherit', env, shell: true });

process.exit(result.status ?? 1);
