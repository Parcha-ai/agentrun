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
test("a subset builds in dependency order: dsl before decisions, the kernel before a harness", async () => {
  const mod = await ordering();
  assert.ok(mod?.subsetOrder, 'scripts/build-workspaces.mjs exports subsetOrder');
  // Given in directory order, the order npm's -w would build them in.
  const built = ['@parcha/agentrun-decisions', '@parcha/agentrun-dsl', '@parcha/agentrun-kernel', '@parcha/agentrun-harness-claude', '@parcha/pi-browser'];
  const order = mod.subsetOrder(mod.workspaces(), built, () => true);
  assert.deepEqual([...order].sort(), [...built].sort(), 'the set, each once, nothing else');
  const at = (name) => order.indexOf(name);
  for (const [later, earlier] of [['@parcha/agentrun-decisions', '@parcha/agentrun-dsl'], ['@parcha/agentrun-harness-claude', '@parcha/agentrun-kernel']]) {
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
// everything in order; `--only` and `--changed` key on a build stamp (node_modules/.cache/agentrun-build-stamp) written after a build that succeeded: a
// package is stale with no stamp, with inputs that differ from its stamp's, or with a dependency that is stale or was built
// again since.
const packagesAB = [{ name: 'a', deps: [], build: true }, { name: 'b', deps: ['a'], build: true }, { name: 'c', deps: ['b'], build: true }, { name: 'n', deps: ['a'], build: false }];
/** Stamps as `stalePackages` reads them: each built package's inputs and the ids of the dependencies it was built against. */
const stamps = (spec) => ({ inputs: (p) => spec[p.name]?.now, stamp: (p) => (spec[p.name] ? { id: spec[p.name].id, inputs: spec[p.name].built, deps: spec[p.name].deps ?? {} } : undefined) });
const current = { a: { id: 'A1', built: 'x', now: 'x' }, b: { id: 'B1', built: 'y', now: 'y', deps: { a: 'A1' } }, c: { id: 'C1', built: 'z', now: 'z', deps: { b: 'B1' } } };

test('a package is stale with no stamp, with inputs that differ from its stamp, or with a stale dependency; a current one is not', async () => {
  const mod = await ordering();
  assert.ok(mod?.stalePackages, 'scripts/build-workspaces.mjs exports stalePackages');
  const order = mod.buildOrder(packagesAB);
  const stale = (spec) => [...mod.stalePackages(packagesAB, order, stamps(spec))];
  assert.deepEqual(stale(current), [], 'every stamp current: nothing to build');
  // a's inputs changed since its stamp: a, and b and c that compile against it. The package with no build is never stale.
  assert.deepEqual(stale({ ...current, a: { ...current.a, now: 'edited' } }), ['a', 'b', 'c']);
  // Only c's changed: c alone.
  assert.deepEqual(stale({ ...current, c: { ...current.c, now: 'edited' } }), ['c']);
  // No stamp at all (never built, a dist cleared, a build that failed): stale, and so what depends on it.
  const { b: _gone, ...noB } = current;
  assert.deepEqual(stale(noB), ['b', 'c']);
});

test('a package is stale once a dependency was built again after it, though its own inputs did not change', async () => {
  const mod = await ordering();
  assert.ok(mod?.stalePackages, 'scripts/build-workspaces.mjs exports stalePackages');
  const order = mod.buildOrder(packagesAB);
  // a was built again (only a: `--only a`): its stamp has a new id, and b's records the old one. b is stale, and so is c.
  const rebuilt = { ...current, a: { ...current.a, id: 'A2' } };
  assert.deepEqual([...mod.stalePackages(packagesAB, order, stamps(rebuilt))], ['b', 'c']);
});

test('a build of some packages builds the stale ones they depend on, and leaves current ones alone', async () => {
  const mod = await ordering();
  assert.ok(mod?.withStaleDeps, 'scripts/build-workspaces.mjs exports withStaleDeps');
  assert.deepEqual(mod.withStaleDeps(packagesAB, ['c'], new Set(['a', 'b'])).sort(), ['a', 'b', 'c'], 'c with its stale dependencies, through any depth');
  assert.deepEqual(mod.withStaleDeps(packagesAB, ['c'], new Set()), ['c'], 'nothing stale: just c');
  assert.deepEqual(mod.withStaleDeps(packagesAB, ['c'], new Set(['a'])).sort(), ['a', 'c'], 'a stale dist under a current one is still built');
});

test('a package a build is asked for counts as stale, so a current dependency between two named ones is built too', async () => {
  const mod = await ordering();
  const order = mod.buildOrder(packagesAB);
  assert.deepEqual([...mod.stalePackages(packagesAB, order, { ...stamps(current), force: new Set(['a', 'c']) })], ['a', 'b', 'c'], 'a is built again, so b is behind it');
  const stale = mod.stalePackages(packagesAB, order, { ...stamps(current), force: new Set(['a', 'c']) });
  assert.deepEqual(mod.withStaleDeps(packagesAB, ['a', 'c'], stale).sort(), ['a', 'b', 'c'], '--only a,c: b is built between them');
});

test('serve reads the console build', async () => {
  const mod = await ordering();
  const dir = mkdtempSync(join(tmpdir(), 'build-workspaces-reads-'));
  try {
    const touch = (path, text, at) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); utimesSync(join(dir, path), at, at); };
    touch('packages/serve/src/a.ts', 'a', 100);
    touch('apps/console/dist/index.html', 'console', 100);
    const serve = { name: '@parcha/agentrun-serve', dir: join(dir, 'packages/serve') };
    const s0 = mod.inputsOf(serve, dir);
    touch('apps/console/dist/index.html', 'console 2', 120);
    assert.notEqual(mod.inputsOf(serve, dir), s0, 'a rebuilt console is an input of serve');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what a build reads changes the inputs hash: an edit, a file added or deleted, and the root compiler settings', async () => {
  const mod = await ordering();
  assert.ok(mod?.inputsOf, 'scripts/build-workspaces.mjs exports inputsOf');
  const dir = mkdtempSync(join(tmpdir(), 'build-workspaces-inputs-'));
  try {
    const touch = (path, text, at) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); utimesSync(join(dir, path), at, at); };
    touch('packages/p/src/a.ts', 'a', 100);
    touch('packages/p/src/b.ts', 'b', 100);
    touch('tsconfig.base.json', '{}', 100);
    touch('packages/p/dist/index.js', 'built', 900);
    touch('packages/p/node_modules/x/index.js', 'dep', 900);
    const pkg = { dir: join(dir, 'packages/p') };
    const base = mod.inputsOf(pkg, dir);
    assert.equal(mod.inputsOf(pkg, dir), base, 'the same files: the same hash');
    touch('packages/p/dist/other.js', 'more output', 950);
    touch('packages/p/node_modules/y/index.js', 'more', 950);
    assert.equal(mod.inputsOf(pkg, dir), base, 'its dist and node_modules are not inputs');
    touch('packages/p/src/a.ts', 'a', 120);
    assert.notEqual(mod.inputsOf(pkg, dir), base, 'a file edited');
    touch('packages/p/src/a.ts', 'a', 100);
    assert.equal(mod.inputsOf(pkg, dir), base, 'and put back');
    rmSync(join(dir, 'packages/p/src/b.ts'));
    assert.notEqual(mod.inputsOf(pkg, dir), base, 'a file deleted, though every file left is older than the dist');
    touch('packages/p/src/b.ts', 'b', 100);
    touch('packages/p/src/c.ts', 'c', 100);
    assert.notEqual(mod.inputsOf(pkg, dir), base, 'a file added');
    rmSync(join(dir, 'packages/p/src/c.ts'));
    touch('tsconfig.base.json', '{"compilerOptions":{"sourceMap":true}}', 130);
    assert.notEqual(mod.inputsOf(pkg, dir), base, 'the root compiler settings');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The script itself, on a tree of its own: a stale package rebuilds and a current one does not, a failed build never reads as
// current, and a package built again rebuilds what depends on it.
test('--changed and --only on a tree of their own: stale packages build, current ones do not, a failed build is tried again, a rebuilt dependency rebuilds its dependents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-workspaces-run-'));
  try {
    const write = (path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
    // A build writes dist/built and appends its name to the tree's log, so the test reads what was built and in what order;
    // a package whose marker file `fail` is there emits its dist and then fails, as tsc does with a type error.
    const log = join(dir, 'log').replaceAll('\\', '/');
    const build = (name) => `node -e "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/built',String(Date.now()));fs.appendFileSync('${log}','${name}\\n');if(fs.existsSync('fail'))process.exit(1)"`;
    write('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    for (const [name, deps] of [['a', {}], ['b', { '@t/a': '1' }]]) write(`packages/${name}/package.json`, JSON.stringify({ name: `@t/${name}`, version: '1.0.0', dependencies: deps, scripts: { build: build(name) } }));
    write('packages/a/src/index.ts', 'one');
    write('packages/b/src/index.ts', 'one');
    const go = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts/build-workspaces.mjs'), '--root', dir, ...args], { encoding: 'utf8' });
    const run = (...args) => { const r = go(...args); assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
    const built = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : []);
    const edit = (path, text) => { write(path, text); const at = Date.now() / 1000 + 5; utimesSync(join(dir, path), at, at); };

    run('--changed');
    assert.deepEqual(built(), ['a', 'b'], 'no stamp: both build, a first');
    assert.ok(!existsSync(join(dir, 'packages/a/dist/.build-stamp')), 'the stamp is not in the dist, which npm pack would carry');
    rmSync(join(dir, 'packages/b/dist'), { recursive: true });
    assert.equal(run('--stale').stdout, '@t/b\n', 'a cleared dist is stale');
    run('--changed');
    assert.deepEqual(built(), ['a', 'b', 'b'], 'b alone');
    run('--changed');
    assert.deepEqual(built(), ['a', 'b', 'b'], 'nothing changed: nothing builds');
    assert.match(run('--changed').stdout, /up to date/);

    // A source of a changes: a rebuilds, and b with it, which compiles against a's new dist.
    edit('packages/a/src/index.ts', 'two');
    assert.equal(run('--stale').stdout, '@t/a\n@t/b\n', 'a and its dependent are stale');
    run('--changed');
    assert.deepEqual(built(), ['a', 'b', 'b', 'a', 'b'], 'a, then b');
    assert.equal(run('--stale').stdout, '', 'built again: current');

    // A file deleted from a package makes it stale, though every file left is older than its dist.
    write('packages/a/src/extra.ts', 'extra');
    run('--changed');
    rmSync(join(dir, 'packages/a/src/extra.ts'));
    assert.equal(run('--stale').stdout, '@t/a\n@t/b\n', 'a file deleted: a, and b with it');
    run('--changed');

    // `--only a` builds a alone; b, whose build ran against a's earlier build, is stale after it.
    const before = built().length;
    run('--only', '@t/a');
    assert.deepEqual(built().slice(before), ['a'], 'a alone');
    assert.equal(run('--stale').stdout, '@t/b\n', 'b was built against an older a');
    run('--changed');
    assert.deepEqual(built().slice(before), ['a', 'b']);

    // A build that fails after emitting its dist is not current: it is tried again, and still fails.
    edit('packages/a/src/index.ts', 'three');
    write('packages/a/fail', '1');
    const failed = go('--changed');
    assert.notEqual(failed.status, 0, 'a failing build fails the run');
    assert.ok(existsSync(join(dir, 'packages/a/dist/built')), 'and it left output behind');
    const again = built().length;
    const second = go('--changed');
    assert.notEqual(second.status, 0, 'the failure is not skipped');
    assert.equal(built().length, again + 1, 'a was built again');
    rmSync(join(dir, 'packages/a/fail'));
    run('--changed');
    assert.equal(run('--stale').stdout, '', 'fixed: current');

    // A direct `npm run build -w` that deletes the dist and is cut short leaves a dist the stamp never described: not current.
    rmSync(join(dir, 'packages/a/dist'), { recursive: true });
    write('packages/a/dist/partial', 'half a build');
    assert.equal(run('--stale').stdout, '@t/a\n@t/b\n', 'a rebuilt-by-hand, unfinished dist is stale, and so is what depends on it');
    run('--changed');
    assert.equal(run('--stale').stdout, '', 'built by the script: current');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
