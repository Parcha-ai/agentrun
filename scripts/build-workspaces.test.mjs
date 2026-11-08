// The root build orders the workspaces by their dependencies (scripts/build-workspaces.mjs): each package after every
// workspace package it names, so none compiles against a dist an earlier build left behind. A package's own build
// compiles itself alone: none builds, or skips building, a dependency (`test -f ../<dep>/dist/... || npm --prefix ...`),
// which trusted any dist already there, a stale one after a merge too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const manifest = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
/** The ordering module, or undefined where it is not in the tree. */
const ordering = () => import('./build-workspaces.mjs').catch(() => undefined);

test("the root build builds the workspaces through build-workspaces.mjs, in dependency order, never npm's `--workspaces` order", () => {
  const build = manifest('package.json').scripts.build;
  assert.match(build, /node scripts\/build-workspaces\.mjs/, build);
  assert.doesNotMatch(build, /--workspaces/, build);
});

test("the order from this repository's package.jsons: every package once, after each workspace package it names", async () => {
  const mod = await ordering();
  assert.ok(mod?.buildOrder && mod?.workspaces, 'scripts/build-workspaces.mjs exports workspaces and buildOrder');
  const packages = mod.workspaces();
  const order = mod.buildOrder(packages);
  assert.deepEqual([...order].sort(), packages.map((p) => p.name).sort(), 'every workspace package, once');
  const at = (name) => order.indexOf(name);
  for (const p of packages) for (const dep of p.deps) assert.ok(at(dep) < at(p.name), `${p.name} after ${dep}`);
  // The ones a stale dist broke: harness after pi-durable-disk and the rest it builds on, decisions after dsl.
  for (const [later, earlier] of [
    ['@parcha/agentrun-harness', ['@parcha/pi-durable-disk', '@parcha/agentrun-dsl', '@parcha/agentrun-jev', '@parcha/agentrun-pi', '@parcha/pi-browser', '@parcha/pi-transport', '@parcha/pi-vision']],
    ['@parcha/agentrun-decisions', ['@parcha/agentrun-dsl']],
  ]) for (const dep of earlier) assert.ok(at(dep) >= 0 && at(dep) < at(later), `${later} after ${dep}: ${order.join(', ')}`);
});

test('a cycle among the workspaces fails loud, naming it', async () => {
  const mod = await ordering();
  assert.ok(mod?.buildOrder, 'scripts/build-workspaces.mjs exports buildOrder');
  const packages = [{ name: 'a', deps: ['b'] }, { name: 'b', deps: ['c'] }, { name: 'c', deps: ['a'] }, { name: 'd', deps: [] }];
  assert.throws(() => mod.buildOrder(packages), /cycle: a -> b -> c -> a/);
});

test('the workspaces are read from the root package.json: devDependencies and peerDependencies count, outside packages do not', async () => {
  const mod = await ordering();
  assert.ok(mod?.workspaces, 'scripts/build-workspaces.mjs exports workspaces');
  const dir = mkdtempSync(join(tmpdir(), 'build-workspaces-'));
  try {
    const write = (path, value) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), JSON.stringify(value)); };
    write('package.json', { workspaces: ['packages/*'] });
    write('packages/z/package.json', { name: 'z', scripts: { build: 'true' } });
    write('packages/y/package.json', { name: 'y', devDependencies: { z: '1' }, dependencies: { lodash: '4' } });
    write('packages/x/package.json', { name: 'x', peerDependencies: { y: '1' }, scripts: { build: 'true' } });
    const packages = mod.workspaces(dir);
    assert.deepEqual(packages.map(({ name, deps, build }) => ({ name, deps, build })).sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'x', deps: ['y'], build: true },
      { name: 'y', deps: ['z'], build: false },
      { name: 'z', deps: [], build: true },
    ]);
    assert.deepEqual(mod.buildOrder(packages), ['z', 'y', 'x']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no package's build builds, or skips building, a dependency: each compiles itself alone", () => {
  const offenders = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      let build;
      try { build = manifest(`packages/${entry.name}/package.json`).scripts?.build; } catch { return []; }
      return typeof build === 'string' && /npm --prefix \.\.\/|test -f \.\.\//.test(build) ? [entry.name] : [];
    });
  assert.deepEqual(offenders, []);
});

// A build of some workspaces goes through the same order: the set, in dependency order (`--only`). npm's own `-w a -w b`
// order is the workspaces' directory order, which built decisions before dsl and harness before pi-durable-disk once no
// package built its dependencies itself.
test("a subset builds in dependency order: dsl before decisions, pi-durable-disk and pi-browser before harness, pi before pi-durable-agent", async () => {
  const mod = await ordering();
  assert.ok(mod?.subsetOrder, 'scripts/build-workspaces.mjs exports subsetOrder');
  // Given in directory order, the order npm's -w would build them in.
  const built = ['@parcha/agentrun-decisions', '@parcha/agentrun-dsl', '@parcha/agentrun-harness', '@parcha/agentrun-pi', '@parcha/pi-browser', '@parcha/pi-durable-agent', '@parcha/pi-durable-disk'];
  const order = mod.subsetOrder(mod.workspaces(), built, () => true);
  assert.deepEqual([...order].sort(), [...built].sort(), 'the set, each once, nothing else');
  const at = (name) => order.indexOf(name);
  for (const [later, earlier] of [['@parcha/agentrun-decisions', '@parcha/agentrun-dsl'], ['@parcha/agentrun-harness', '@parcha/pi-durable-disk'], ['@parcha/agentrun-harness', '@parcha/pi-browser'], ['@parcha/pi-durable-agent', '@parcha/agentrun-pi']]) {
    assert.ok(at(earlier) >= 0 && at(earlier) < at(later), `${later} after ${earlier}: ${order.join(', ')}`);
  }
});

test("a subset whose package depends on a workspace outside it with no dist fails loud, naming both; one with a dist builds", async () => {
  const mod = await ordering();
  assert.ok(mod?.subsetOrder, 'scripts/build-workspaces.mjs exports subsetOrder');
  const packages = [{ name: 'a', deps: [] }, { name: 'b', deps: ['a'] }, { name: 'c', deps: ['b'] }];
  assert.throws(() => mod.subsetOrder(packages, ['b', 'c'], () => false), /b depends on a, which is not in the build and has no dist/);
  assert.deepEqual(mod.subsetOrder(packages, ['c', 'b'], (p) => p.name === 'a'), ['b', 'c']);
  assert.throws(() => mod.subsetOrder(packages, ['z'], () => true), /z is not a workspace/);
});

// The build loop itself (buildAll): each package with a build script once, in the order given; a package with none is
// skipped; the first build that fails stops it, and nothing after it is built.
test('the build loop builds each package once in order, skips one with no build, and stops at the first failure', async () => {
  const mod = await ordering();
  assert.ok(mod?.buildAll, 'scripts/build-workspaces.mjs exports buildAll');
  const packages = [{ name: 'a', deps: [], build: true }, { name: 'b', deps: ['a'], build: false }, { name: 'c', deps: ['b'], build: true }, { name: 'd', deps: ['c'], build: true }];
  const order = mod.buildOrder(packages);
  const calls = [];
  assert.deepEqual(mod.buildAll(packages, order, (name) => (calls.push(name), 0)), { built: ['a', 'c', 'd'] });
  assert.deepEqual(calls, ['a', 'c', 'd'], 'each once, in order, b (no build) skipped');
  calls.length = 0;
  assert.deepEqual(mod.buildAll(packages, order, (name) => (calls.push(name), name === 'c' ? 2 : 0)), { built: ['a'], failed: 'c', status: 2 });
  assert.deepEqual(calls, ['a', 'c'], 'nothing after the failed build ran');
});
