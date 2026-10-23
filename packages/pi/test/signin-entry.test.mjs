// pi-ai is an optional peer of this package that only ./signin may reach: every other entry reaches no
// @earendil-works/pi-ai, and a consumer without it installed imports them. The check follows the built files' imports,
// as the durable entry's does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reachableImports } from '../../../scripts/reachable-imports.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const PI_AI = '@earendil-works/pi-ai';
const reachesPiAi = (file) => reachableImports(packageRoot, file).filter((specifier) => specifier === PI_AI || specifier.startsWith(`${PI_AI}/`));

test('pi-ai is an optional peer at "*", and ./signin reaches it', () => {
  assert.equal(manifest.peerDependencies[PI_AI], '*');
  assert.equal(manifest.peerDependenciesMeta[PI_AI]?.optional, true);
  for (const file of Object.values(manifest.exports['./signin'])) assert.notDeepEqual(reachesPiAi(file), [], file);
});

const OTHERS = Object.keys(manifest.exports).filter((entry) => entry !== './signin');

test('every entry but ./signin reaches no pi-ai', () => {
  assert.ok(OTHERS.includes('.') && OTHERS.includes('./durable'), OTHERS.join(' '));
  for (const entry of OTHERS) {
    for (const file of Object.values(manifest.exports[entry])) assert.deepEqual(reachesPiAi(file), [], `${entry}: ${file}`);
  }
});

// The child resolves pi-ai as missing for this package's own files, as for a consumer that never installed it. The
// packages this one loads keep theirs: what is tested is this package's imports.
const WITHOUT_PI_AI = `
import { registerHooks } from 'node:module';
const dist = ${JSON.stringify(new URL('../dist/', import.meta.url).href)};
registerHooks({
  resolve(specifier, context, next) {
    if ((specifier === '${PI_AI}' || specifier.startsWith('${PI_AI}/')) && context.parentURL?.startsWith(dist)) {
      throw Object.assign(new Error('Cannot find package ' + specifier), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return next(specifier, context);
  },
});
for (const entry of JSON.parse(process.argv[1])) {
  try { await import(entry); console.log('ok ' + entry); } catch (error) { console.log('failed ' + entry + ': ' + (error.code ?? String(error.message).split('\\n')[0])); }
}`;

test('a consumer without pi-ai imports every entry but ./signin', () => {
  const entries = [...OTHERS, './signin'].map((entry) => join(manifest.name, entry).replace(/\/\.$/, ''));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', WITHOUT_PI_AI, JSON.stringify(entries)], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.deepEqual(lines.slice(0, -1), entries.slice(0, -1).map((entry) => `ok ${entry}`));
  assert.equal(lines.at(-1), `failed ${manifest.name}/signin: ERR_MODULE_NOT_FOUND`, 'the hook removes pi-ai: ./signin cannot load without it');
});
