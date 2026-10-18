// docs/examples.md promises a command and a page for each example: every `npm run` it names is a script in the root
// manifest, and every relative link in it resolves to a file, so an example that is renamed or removed fails here
// instead of leaving a row that points nowhere.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = readFileSync(join(root, 'docs/examples.md'), 'utf8');
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;

test('every npm script the examples index names exists', () => {
  const named = [...index.matchAll(/`npm run ([^\s`]+)/g)].map(match => match[1]);
  assert.ok(named.length >= 6, 'the index names its examples\' commands');
  assert.deepEqual(named.filter(name => !(name in scripts)), []);
});

test('every relative link in the examples index resolves to a file', () => {
  const links = [...index.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)].map(match => match[1]);
  assert.ok(links.length >= 6, 'the index links its examples');
  assert.deepEqual(links.filter(link => !existsSync(resolve(root, 'docs', link))), []);
});
