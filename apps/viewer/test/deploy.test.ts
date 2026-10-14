// The deploy buttons publish this replay viewer only: no config and no button asks for a model or provider key. Each
// config's keys and each button's query parameters are listed here, so a new one (an env var, a binding, a secret)
// fails until it is reviewed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const keys = (value: unknown) => Object.keys(value as object).sort();

test('the Cloudflare config is static assets and a build: no vars, secrets or bindings', () => {
  const config = JSON.parse(read('wrangler.json'));
  assert.deepEqual(keys(config), ['assets', 'build', 'compatibility_date', 'name']);
  assert.deepEqual(keys(config.build), ['command']);
  assert.deepEqual(keys(config.assets), ['directory']);
});

test('the Vercel config is a build and its output: no env', () => {
  assert.deepEqual(keys(JSON.parse(read('vercel.json'))), ['buildCommand', 'framework', 'installCommand', 'outputDirectory']);
});

test('each deploy button names the repository and the viewer, and asks for no env var', () => {
  // A button is a line `[![alt](badge)](target)`: the target is what follows the badge's closing `](`.
  const targets = read('README.md').split('\n').filter((line) => line.startsWith('[![Deploy')).map((line) => new URL(line.slice(line.lastIndexOf('](') + 2, -1)));
  // Each target, decoded: where it deploys from, and every parameter it passes (a repeated one included).
  assert.deepEqual(targets.map((url) => [`${url.host}${url.pathname}`, [...url.searchParams]]), [
    ['deploy.workers.cloudflare.com/', [['url', 'https://github.com/Parcha-ai/agentrun/tree/main/apps/viewer']]],
    ['vercel.com/new/clone', [['repository-url', 'https://github.com/Parcha-ai/agentrun'], ['root-directory', 'apps/viewer']]],
  ]);
});

test('the README says what the buttons deploy', () => {
  assert.ok(read('README.md').includes('The buttons deploy this replay viewer only: it plays recorded runs, never runs an agent or calls a model, and asks for no key.'));
});
