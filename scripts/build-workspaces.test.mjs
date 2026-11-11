// The root build orders the workspaces by their dependencies (scripts/build-workspaces.mjs): each package after every
// workspace package it names, so none compiles against a dist an earlier build left behind. A package's own build
// compiles itself alone: none builds, or skips building, a dependency (`test -f ../<dep>/dist/... || npm --prefix ...`),
// which trusted any dist already there, a stale one after a merge too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  // The ones a stale dist broke: decisions after dsl.
  for (const [later, earlier] of [
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
// order is the workspaces' directory order, which built decisions before dsl once no package built its dependencies itself.
test("a subset builds in dependency order: dsl before decisions, pi before pi-durable-agent", async () => {
  const mod = await ordering();
  assert.ok(mod?.subsetOrder, 'scripts/build-workspaces.mjs exports subsetOrder');
  // Given in directory order, the order npm's -w would build them in.
  const built = ['@parcha/agentrun-decisions', '@parcha/agentrun-dsl', '@parcha/agentrun-pi', '@parcha/pi-browser', '@parcha/pi-durable-agent', '@parcha/pi-durable-disk'];
  const order = mod.subsetOrder(mod.workspaces(), built, () => true);
  assert.deepEqual([...order].sort(), [...built].sort(), 'the set, each once, nothing else');
  const at = (name) => order.indexOf(name);
  for (const [later, earlier] of [['@parcha/agentrun-decisions', '@parcha/agentrun-dsl'], ['@parcha/pi-durable-agent', '@parcha/agentrun-pi']]) {
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

// Freshness (#1025): a package builds against its dependencies' dists as the tree's sources make them. The root build rebuilds
// everything in order; `--only` and `--changed` key on the sources: a package is stale when its dist is missing or older than a
// file of the package, or a package it depends on is stale.
const packagesAB = [{ name: 'a', deps: [], build: true }, { name: 'b', deps: ['a'], build: true }, { name: 'c', deps: ['b'], build: true }, { name: 'n', deps: ['a'], build: false }];
/** Modification times by package name, as `stalePackages` reads them. */
const times = (sources, dist) => ({ sources: (p) => sources[p.name] ?? 0, dist: (p) => dist[p.name] ?? 0 });

test('a package is stale when its dist is missing or older than its sources, and so is each package that depends on it; fresh ones are not', async () => {
  const mod = await ordering();
  assert.ok(mod?.stalePackages, 'scripts/build-workspaces.mjs exports stalePackages');
  const order = mod.buildOrder(packagesAB);
  // Every dist newer than every source: nothing to build.
  assert.deepEqual([...mod.stalePackages(packagesAB, order, times({ a: 5, b: 5, c: 5 }, { a: 9, b: 9, c: 9 }))], []);
  // a's source changed after its dist was built: a, and b and c that compile against it. The package with no build is never stale.
  assert.deepEqual([...mod.stalePackages(packagesAB, order, times({ a: 10, b: 5, c: 5 }, { a: 9, b: 9, c: 9 }))], ['a', 'b', 'c']);
  // Only c changed: c alone.
  assert.deepEqual([...mod.stalePackages(packagesAB, order, times({ a: 5, b: 5, c: 10 }, { a: 9, b: 9, c: 9 }))], ['c']);
  // No dist at all: stale.
  assert.deepEqual([...mod.stalePackages(packagesAB, order, times({ a: 5, b: 5, c: 5 }, { a: 9, c: 9 }))], ['b', 'c']);
});

test('a build of some packages builds the stale ones they depend on, and leaves fresh ones alone', async () => {
  const mod = await ordering();
  assert.ok(mod?.withStaleDeps, 'scripts/build-workspaces.mjs exports withStaleDeps');
  assert.deepEqual(mod.withStaleDeps(packagesAB, ['c'], new Set(['a', 'b'])).sort(), ['a', 'b', 'c'], 'c with its stale dependencies, through any depth');
  assert.deepEqual(mod.withStaleDeps(packagesAB, ['c'], new Set()), ['c'], 'nothing stale: just c');
  assert.deepEqual(mod.withStaleDeps(packagesAB, ['c'], new Set(['a'])).sort(), ['a', 'c'], 'a stale dist under a fresh one is still built');
});

test('the newest mtime walks a package without its dist and node_modules', async () => {
  const mod = await ordering();
  assert.ok(mod?.newestMtime, 'scripts/build-workspaces.mjs exports newestMtime');
  const dir = mkdtempSync(join(tmpdir(), 'build-workspaces-mtime-'));
  try {
    const touch = (path, at) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), ''); utimesSync(join(dir, path), at, at); };
    touch('src/deep/a.ts', 100);
    touch('tsconfig.json', 300);
    touch('dist/index.js', 900);
    touch('node_modules/x/index.js', 800);
    assert.equal(mod.newestMtime(dir), 300_000, 'the tsconfig, not the dist or node_modules');
    assert.equal(mod.newestMtime(join(dir, 'dist'), new Set()), 900_000);
    assert.equal(mod.newestMtime(join(dir, 'absent')), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The script itself, on a tree of its own: a stale dist and a changed source must rebuild, and nothing changed must not.
test('--changed rebuilds a package and its dependents after a source changes, and builds nothing when nothing changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-workspaces-run-'));
  try {
    const write = (path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
    // A build writes dist/built and appends its name to the tree's log, so the test reads what was built and in what order.
    const build = (name) => `node -e "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/built',String(Date.now()));fs.appendFileSync('${join(dir, 'log').replaceAll('\\', '/')}','${name}\\n')"`;
    write('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    for (const [name, deps] of [['a', {}], ['b', { '@t/a': '1' }]]) write(`packages/${name}/package.json`, JSON.stringify({ name: `@t/${name}`, version: '1.0.0', dependencies: deps, scripts: { build: build(name) } }));
    write('packages/a/src/index.ts', 'one');
    write('packages/b/src/index.ts', 'one');
    const run = (...args) => { const r = spawnSync(process.execPath, [join(ROOT, 'scripts/build-workspaces.mjs'), '--root', dir, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
    const built = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : []);
    // A dist from before the sources' last edit: its files aged by a minute.
    const aged = (path) => { const at = Date.now() / 1000 - 60; utimesSync(join(dir, path), at, at); };

    run('--changed');
    assert.deepEqual(built(), ['a', 'b'], 'no dist: both build, a first');
    run('--changed');
    assert.deepEqual(built(), ['a', 'b'], 'nothing changed: nothing builds');
    assert.match(run('--changed').stdout, /up to date/);

    // A source of a changes after its dist was built (a's dist is a minute older than its source): a rebuilds, and b with it,
    // which compiles against a's new dist.
    aged('packages/a/dist/built');
    assert.equal(run('--stale').stdout, '@t/a\n@t/b\n', 'a and its dependent are stale');
    run('--changed');
    assert.deepEqual(built(), ['a', 'b', 'a', 'b'], 'a, then b');
    assert.equal(run('--stale').stdout, '', 'built again: fresh');

    // A build of b alone builds the stale dependency it would compile against, and not a fresh one.
    aged('packages/a/dist/built');
    run('--only', '@t/b');
    assert.deepEqual(built(), ['a', 'b', 'a', 'b', 'a', 'b'], 'b with its stale dependency a, a first');
    run('--only', '@t/b');
    assert.deepEqual(built(), ['a', 'b', 'a', 'b', 'a', 'b', 'b'], 'a fresh: only b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
