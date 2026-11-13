// The pi family in this repository is one version: pi 1.5.0, tracked at the latest (pi pins its own packages to exact
// versions, so an install is one whole family). Every package depends on the family at exactly that version and names
// it so in its peer ranges; the packages Pi itself provides to the packages it loads (pi-ai, pi-agent-core,
// pi-coding-agent, pi-tui, typebox) stay "*", as Pi's package guidance asks. One typebox serves the whole tree: the one
// pi-coding-agent pins, so no second copy nests under it. No CI leg, script or test installs an older pi.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
/** The pi family's version: every @earendil-works package, pinned and peered at exactly this. */
export const PI = '1.5.0';
/** The one typebox of the tree: pi-coding-agent 1.5.0 pins it exactly. */
export const TYPEBOX = '1.3.27';
const FAMILY = '@earendil-works/';
const HOST_PROVIDED = ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'];

const workspaces = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).workspaces.flatMap((pattern) => {
  const base = join(repo, pattern.replace(/\/\*$/, ''));
  return readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => ({ dir: join(base, entry.name), manifest: JSON.parse(readFileSync(join(base, entry.name, 'package.json'), 'utf8')) }));
});

for (const { manifest } of workspaces) {
  const deps = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies });
  const peers = Object.entries(manifest.peerDependencies ?? {});
  if (![...deps, ...peers].some(([name]) => name.startsWith(FAMILY) || name === 'typebox')) continue;
  test(`${manifest.name}: the pi family at exactly ${PI}, in its dependencies and its peer ranges; typebox at ${TYPEBOX}`, () => {
    for (const [name, range] of deps) {
      if (name.startsWith(FAMILY)) assert.equal(range, PI, `${manifest.name}: ${name} is "${range}"`);
      if (name === 'typebox') assert.equal(range, TYPEBOX, `${manifest.name}: typebox is "${range}"`);
    }
    for (const [name, range] of peers) {
      if (HOST_PROVIDED.includes(name)) assert.equal(range, '*', `${manifest.name}: ${name} is "${range}"; Pi's package guidance asks for "*"`);
      else if (name.startsWith(FAMILY)) assert.equal(range, PI, `${manifest.name}: peer ${name} is "${range}"`);
    }
  });
}

test(`the lock holds one pi family (${PI}) and one typebox (${TYPEBOX})`, () => {
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')).packages;
  const off = Object.entries(lock).filter(([path, entry]) => {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!path.includes('node_modules/')) return false;
    if (name.startsWith(FAMILY)) return entry.version !== PI;
    return name === 'typebox' && entry.version !== TYPEBOX;
  }).map(([path, entry]) => `${path}@${entry.version}`);
  assert.deepEqual(off, []);
});

test('no CI leg, script or test installs an older pi', () => {
  // The version legs and the scripts that ran them are gone: the family is one version, and the workspace is tested on it.
  // (pi-family-pins.mjs and consumer-pi.mjs stay: the package checks' consumer installs read them, at the one version.)
  for (const file of ['scripts/pi-leg.mjs', 'scripts/pi-leg.test.mjs', 'scripts/pi-cross-version.mjs']) {
    assert.equal(existsSync(join(repo, file)), false, `${file} is gone`);
  }
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  for (const leg of ['pi-leg', 'pi-floor', 'pi-1-2', 'pi-cross-version', 'PI_LEGS', '--pi ']) assert.equal(ci.includes(leg), false, `ci.yml names ${leg}`);
  // An older family named as a version a script or a test installs or expects.
  const older = /@earendil-works\/[a-z-]+@1\.[0-4]\.\d|--pi\s+["']?1\.[0-4]\.\d|PI_EXPECT_VERSION/;
  const sources = [
    ...readdirSync(join(repo, 'scripts')).filter((name) => /\.m?js$/.test(name) && name !== 'pi-ranges.test.mjs').map((name) => join('scripts', name)),
    ...workspaces.flatMap(({ dir }) => (existsSync(join(dir, 'test')) ? readdirSync(join(dir, 'test')).filter((name) => /\.test\.(m?js|ts)$/.test(name)).map((name) => join(dir, 'test', name)) : [])),
  ];
  const named = sources.filter((file) => older.test(readFileSync(join(repo, file.startsWith('/') ? file.slice(repo.length + 1) : file), 'utf8')));
  assert.deepEqual(named.map((file) => file.replace(`${repo}/`, '')), []);
});
