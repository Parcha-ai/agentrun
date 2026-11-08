// The test plan: a made-up repository's suites, their units and the shards they land in (longest first, each unit once,
// the same plan every time), then this repository's own: every test file in one shard, and ci.yml's matrices in step
// with scripts/ci-shards.json.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { checkCover, commandsOf, modelSeconds, plan, pools, readConfig, readSuites, testShards, timingDrift, unitsOf } from './ci-plan.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'ci-plan-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const unit = (id, seconds, suite = 's', parallelism = 1) => ({ id, suite, kind: 'file', file: id, seconds, parallelism });
const ids = (shard) => shard.units.map((u) => u.id);

/** A repository: workspaces { dir: [name, test script, files] }, root scripts, and ci-shards.json. */
function repo(name, { workspaces = {}, scripts = {}, files = [], config = {} }) {
  const root = join(scratch, name);
  write(join(root, 'package.json'), { name, private: true, workspaces: ['packages/*'], scripts });
  mkdirSync(join(root, 'packages'), { recursive: true });
  for (const [dir, [pkg, script, tests]] of Object.entries(workspaces)) {
    write(join(root, 'packages', dir, 'package.json'), { name: pkg, scripts: script === undefined ? {} : { test: script } });
    for (const file of tests) write(join(root, 'packages', dir, file), '');
  }
  for (const file of files) write(join(root, file), '');
  write(join(root, 'scripts/ci-shards.json'), { pools: { any: { shards: 1 } }, ...config });
  return root;
}

test('the plan puts the longest units first, each on the shard it lengthens least, and every unit in exactly one shard', () => {
  const units = [unit('a', 10), unit('b', 9), unit('c', 8), unit('d', 2), unit('e', 2), unit('f', 1)];
  const shards = plan(units, 3);
  assert.deepEqual(shards.map(ids), [['a', 'f'], ['b', 'e'], ['c', 'd']]);
  checkCover(units, shards);
  assert.deepEqual(plan([...units].reverse(), 3).map(ids), shards.map(ids), 'the order units come in does not change the plan');
  assert.deepEqual(plan(units, 1).map(ids), [['a', 'b', 'c', 'd', 'e', 'f']]);
  assert.equal(plan(units, 8).filter((shard) => !shard.units.length).length, 2, 'more shards than units leaves some empty');
  assert.throws(() => plan([unit('a', 1), unit('a', 2)], 2), /the unit a appears twice/);
  assert.throws(() => plan(units, 0), /a whole number of shards/);
});

test("a suite's files in one shard take its longest file or their total over its parallelism, whichever is more", () => {
  // One suite of parallelism 4: a 100 s file and four 20 s files fit under the long one; a second suite adds its own time.
  const serve = [unit('long', 100, 'serve', 4), ...[1, 2, 3, 4].map((n) => unit(`short-${n}`, 20, 'serve', 4))];
  assert.equal(modelSeconds(serve), 2 + 100);
  assert.equal(modelSeconds([...serve, ...[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => unit(`short-${n}`, 20, 'serve', 4))]), 2 + 420 / 4);
  assert.equal(modelSeconds([...serve, unit('other', 30, 'other')]), 2 + 100 + 2 + 30);
  // Two shards: the short files of the long one's suite go beside it, where they cost nothing, before a shard of their own.
  const shards = plan([...serve, unit('x', 60, 'other'), unit('y', 50, 'other')], 2);
  assert.deepEqual(shards.map(ids), [['long', 'short-1', 'short-2', 'short-3', 'short-4'], ['x', 'y']]);
});

test('a file with no timing weighs its suite\'s median, a suite with none a default, a whole suite its wall; nothing is dropped', () => {
  const root = repo('weights', {
    workspaces: { a: ['a', "node --test 'test/*.test.mjs'", ['test/one.test.mjs', 'test/two.test.mjs', 'test/three.test.mjs', 'test/new.test.mjs']], b: ['b', 'node --test test/*.test.mjs', ['test/b.test.mjs']], w: ['w', 'node scripts/run.mjs', []] },
    config: { whole: { w: 'node scripts/run.mjs' } },
  });
  const timings = { files: { 'packages/a/test/one.test.mjs': 10, 'packages/a/test/two.test.mjs': 30, 'packages/a/test/three.test.mjs': 40, 'packages/gone/test/x.test.mjs': 99 }, parallelism: { a: 3 }, walls: { w: 77 }, typecheck: { a: 4 } };
  const units = unitsOf(readSuites(root), timings, { typecheck: ['a', 'b'] });
  const by = Object.fromEntries(units.map((u) => [u.id, [u.seconds, u.parallelism]]));
  assert.deepEqual(by, {
    'file:packages/a/test/new.test.mjs': [30, 3], 'file:packages/a/test/one.test.mjs': [10, 3], 'file:packages/a/test/three.test.mjs': [40, 3], 'file:packages/a/test/two.test.mjs': [30, 3],
    'file:packages/b/test/b.test.mjs': [5, 2], 'suite:w': [77, 1], 'typecheck:a': [4, 1], 'typecheck:b': [10, 1],
  });
});

test('a split suite runs its files with its own flags, --test-timeout added only where its script sets none; a whole suite as it is', () => {
  const root = repo('commands', {
    workspaces: { a: ['@x/a', "node --test --test-concurrency=8 'test/*.test.mjs' 'test/deep/*.test.mjs'", ['test/one.test.mjs', 'test/deep/two.test.mjs']], b: ['@x/b', 'node --test --test-timeout=240000 test/*.test.ts', ['test/b.test.ts']], w: ['@x/w', 'node scripts/run.mjs', []], none: ['@x/none', undefined, []] },
    scripts: { 'test:release': 'node --test scripts/*.test.mjs' },
    files: ['scripts/r.test.mjs'],
    config: { whole: { '@x/w': 'node scripts/run.mjs' }, rootSuites: ['test:release'] },
  });
  const suites = readSuites(root);
  assert.deepEqual(suites.map((s) => [s.name, s.cwd, s.files]), [['@x/a', 'packages/a', ['test/deep/two.test.mjs', 'test/one.test.mjs']], ['@x/b', 'packages/b', ['test/b.test.ts']], ['@x/w', 'packages/w', []], ['test:release', '.', ['scripts/r.test.mjs']]]);
  const units = unitsOf(suites, readConfig(root).timings, { typecheck: ['@x/a'] });
  assert.deepEqual(commandsOf(suites, units, { timeoutMs: 600000 }).map((c) => c.command), [
    ['npm', 'run', 'typecheck', '-w', '@x/a'],
    ['npm', 'exec', '-w', '@x/a', '-c', 'node --test --test-timeout=600000 --test-concurrency=8 test/deep/two.test.mjs test/one.test.mjs'],
    ['npm', 'exec', '-w', '@x/b', '-c', 'node --test --test-timeout=240000 test/b.test.ts'],
    ['npm', 'run', 'test', '-w', '@x/w'],
    ['npm', 'exec', '-c', 'node --test --test-timeout=600000 scripts/r.test.mjs'],
  ]);
  assert.deepEqual(commandsOf(suites, units.filter((u) => u.id === 'file:packages/a/test/one.test.mjs')).map((c) => c.command), [['npm', 'exec', '-w', '@x/a', '-c', 'node --test --test-concurrency=8 test/one.test.mjs']], 'no limit unless asked');
  assert.deepEqual(readSuites(root, { only: ['@x/b'] }).map((s) => s.name), ['@x/b'], 'only: those workspaces, no root suite');
});

test('a script of another shape, a whole suite whose script changed, a glob that matches nothing or a missing root script is refused', () => {
  const refused = (name, options, pattern) => assert.throws(() => readSuites(repo(name, options)), pattern);
  refused('chained', { workspaces: { a: ['a', "node --test 'test/*.test.mjs' && echo done", ['test/a.test.mjs']] } }, /a's test script, "node --test 'test\/\*\.test\.mjs' && echo done", is neither/);
  refused('changed', { workspaces: { w: ['w', 'node scripts/run.mjs --fast', []] }, config: { whole: { w: 'node scripts/run.mjs' } } }, /w's test script, "node scripts\/run\.mjs --fast", is not the one scripts\/ci-shards\.json runs as a whole/);
  refused('empty', { workspaces: { a: ['a', "node --test 'test/*.test.mjs'", []] } }, /a's test script, "node --test 'test\/\*\.test\.mjs'", matches no file/);
  refused('rootless', { config: { rootSuites: ['test:release'] } }, /names the root script test:release, which package.json does not have/);
});

test('each suite is in one pool, and the pool without a list takes every other suite, a new one too', () => {
  const suites = ['a', 'b', 'c', 'new'].map((name) => ({ name }));
  const byPool = pools(suites, { pools: { one: { shards: 2, suites: ['a'] }, rest: { shards: 3 } } });
  assert.deepEqual(Object.fromEntries(Object.entries(byPool).map(([pool, { shards, suites: s }]) => [pool, [shards, s.map((x) => x.name)]])), { one: [2, ['a']], rest: [3, ['b', 'c', 'new']] });
  assert.throws(() => pools(suites, { pools: { one: { suites: ['a'] }, two: { suites: ['a'] }, rest: {} } }), /the suite a is in the pools one and two/);
  assert.throws(() => pools(suites, { pools: { one: { suites: ['a'] } } }), /exactly one pool takes every suite no other pool names/);
  assert.throws(() => pools(suites, { pools: { one: { suites: ['gone'] }, rest: {} } }), /the pool one names gone, which is not a suite/);
});

test('a shard that runs a quarter and a minute over its model warns that ci-timings.json is stale, naming it; one within either does not', () => {
  // any-2 on 11-04: modelled 275 s, its tests ran 398 s, from a timings file a day old.
  assert.match(timingDrift('any-2', 275, 398), /^::warning title=ci-timings\.json is stale::any-2 ran 398 s, modelled 275 s: refresh scripts\/ci-timings\.json from CI's job logs \(node scripts\/ci-timings\.mjs <job log>\.\.\.\)/);
  assert.equal(timingDrift('any-1', 275, 335), undefined, 'a minute over is noise on a hosted runner');
  assert.equal(timingDrift('any-1', 20, 70), undefined, 'under a minute over, however many times its model');
  assert.equal(timingDrift('any-1', 400, 470), undefined, 'over by a minute but under a quarter');
  assert.equal(timingDrift('any-1', 275, 100), undefined, 'faster than its model (a Blacksmith runner in the queue)');
});

test('a cover that drops a unit, runs one twice or adds one is refused, naming it', () => {
  const units = [unit('a', 1), unit('b', 1)];
  assert.throws(() => checkCover(units, [{ units: [units[0]] }]), /b is in no shard/);
  assert.throws(() => checkCover(units, [{ units }, { units: [units[1]] }]), /b \(shards 1, 2\) is in more than one shard/);
  assert.throws(() => checkCover(units, [{ units: [...units, unit('c', 1)] }]), /c is not a unit of the suites/);
});

const root = fileURLToPath(new URL('..', import.meta.url));

test("this repository's shards cover every test file of every suite once, and ci.yml's jobs list every shard", () => {
  const { config } = readConfig(root);
  const suites = readSuites(root, { config });
  const shards = testShards(root);
  const files = (list) => list.filter((u) => u.kind !== 'typecheck').map((u) => u.id).sort();
  assert.deepEqual(files(Object.values(shards).flatMap((s) => s.units)), files(unitsOf(suites, readConfig(root).timings)));
  const workflow = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const testJob = workflow.jobs.test.strategy.matrix.shard;
  assert.deepEqual(testJob, ['checks', 'packages', 'source', ...Object.keys(shards)], 'the test job runs checks, packages, source and every shard');
  const lean = workflow.jobs.lean.steps.find((step) => /collect\.mjs/.test(step.run ?? '')).run;
  assert.deepEqual([...lean.matchAll(/lean-sweep-([\w-]+)/g)].map((m) => m[1]), Object.keys(shards).filter((name) => name.startsWith('lean-')), 'the lean job reads every lean shard\'s captures');
  // The any pool's shards install poppler for serve's pdf_pages; the gh pool's run on GitHub's runners in the queue too.
  assert.ok(Object.values(shards).some((s) => s.pool === 'any' && s.suites.some((x) => x.name === '@parcha/agentrun-serve')), 'serve is in the any pool');
  assert.deepEqual(config.pools.gh.suites, ['@parcha/pi-transport']);
});
