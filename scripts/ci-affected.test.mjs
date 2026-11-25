// What a pull request's affected pool runs, on a made-up repository: the tests its changes reach, every test of a package
// whose changed file no test reaches, nothing for Markdown or a deletion, every test for a shared root or a diff git cannot
// give, and a whole suite only for a pick of its own. Then the plan: the pool keeps only those units, shared by time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { affectedSince, affectedTests } from './ci-affected.mjs';
import { testShards } from './ci-plan.mjs';

// Two split suites (@fx/a, @fx/b), a whole one (@fx/w, its runner listing its files with --list), the root's test:release
// over scripts/*.test.mjs, an `any` pool of two shards that runs the affected tests and a `fixed` pool that runs @fx/b whole.
const FILES = {
  'package.json': JSON.stringify({ name: 'fx', private: true, workspaces: ['packages/*'], scripts: { 'test:release': "node --test 'scripts/*.test.mjs'" } }),
  'scripts/ci-shards.json': JSON.stringify({
    rootSuites: ['test:release'], whole: { '@fx/w': 'node run.mjs' },
    pools: { fixed: { shards: 1, suites: ['@fx/b'] }, any: { shards: 2, affected: true } },
  }),
  'scripts/tool.mjs': 'export const tool = 1;\n',
  'scripts/tool.test.mjs': "import { tool } from './tool.mjs';\n",
  '.github/workflows/ci.yml': 'on: push\n',
  'docs/guide.md': '# Guide\n',
  'packages/a/package.json': JSON.stringify({ name: '@fx/a', version: '1.0.0', type: 'module', exports: { '.': './dist/index.js' }, scripts: { build: 'tsc -p tsconfig.json', test: "node --test 'test/*.test.mjs'" } }),
  'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
  'packages/a/README.md': '# a\n',
  'packages/a/src/index.ts': "export { one } from './one.js';\n",
  'packages/a/src/one.ts': 'export const one = 1;\n',
  // Read by listing its folder: no import or name reaches it.
  'packages/a/migrations/0001_init.sql': 'create table t (id int);\n',
  'packages/a/test/one.test.mjs': "import { one } from '../dist/index.js';\n",
  'packages/a/test/plain.test.mjs': "import test from 'node:test';\n",
  'packages/b/package.json': JSON.stringify({ name: '@fx/b', version: '1.0.0', type: 'module', scripts: { test: "node --test 'test/*.test.mjs'" } }),
  'packages/b/test/b.test.mjs': "import { one } from '@fx/a';\n",
  'packages/w/package.json': JSON.stringify({ name: '@fx/w', version: '1.0.0', type: 'module', scripts: { test: 'node run.mjs' } }),
  'packages/w/run.mjs': "if (process.argv.includes('--list')) console.log('test/w.test.mjs\\ntest/smoke.test.mjs');\n",
  'packages/w/src/w.mjs': 'export const w = 1;\n',
  'packages/w/test/w.test.mjs': "import { w } from '../src/w.mjs';\n",
  'packages/w/test/smoke.test.mjs': "import test from 'node:test';\n",
};
const SMOKE = { '@fx/a': 'test/plain.test.mjs', '@fx/w': 'test/smoke.test.mjs' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-affected-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const run = (root, changed, smoke = {}) => affectedTests(root, changed, { smoke });
const picked = (result) => [...result.files].sort();

test('a source change runs the tests that import it, in every package, and the smoke set; no other test', (t) => {
  const root = fixture(t);
  const result = run(root, ['packages/a/src/one.ts'], SMOKE);
  assert.equal(result.full, undefined);
  assert.deepEqual(picked(result), ['packages/a/test/one.test.mjs', 'packages/a/test/plain.test.mjs', 'packages/b/test/b.test.mjs']);
  assert.deepEqual([...result.suites].sort(), ['@fx/a', '@fx/b']);
});

test('a whole suite runs for a pick of its own, never for its smoke file alone', (t) => {
  const root = fixture(t);
  assert.ok(!run(root, ['docs/guide.md'], SMOKE).suites.has('@fx/w'), 'its smoke file alone does not run a whole suite');
  const own = run(root, ['packages/w/src/w.mjs'], SMOKE);
  assert.ok(own.suites.has('@fx/w'));
  assert.ok(own.files.has('packages/w/test/w.test.mjs'));
});

test('a shared root runs every test, naming it; a test file under scripts/ runs only itself', (t) => {
  const root = fixture(t);
  for (const path of ['scripts/tool.mjs', '.github/workflows/ci.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/ci-shards.json']) {
    assert.equal(run(root, ['packages/a/src/one.ts', path]).full, `${path} is a shared root, which any suite may read`, path);
  }
  const only = run(root, ['scripts/tool.test.mjs']);
  assert.equal(only.full, undefined);
  assert.deepEqual(picked(only), ['scripts/tool.test.mjs']);
});

test("a package's file that no import or name reaches runs that package's every test, and says so; no other package's", (t) => {
  const root = fixture(t);
  const result = run(root, ['packages/a/migrations/0001_init.sql']);
  assert.deepEqual(picked(result), ['packages/a/test/one.test.mjs', 'packages/a/test/plain.test.mjs']);
  assert.deepEqual(result.paths, [{ path: 'packages/a/migrations/0001_init.sql', kinds: {}, note: 'no test imports or names it', widened: 'every test of @fx/a: no import or name reaches it' }]);
});

test('Markdown, a file outside the packages that no test reaches and a deleted file run nothing beyond the smoke set', (t) => {
  const root = fixture(t);
  for (const path of ['packages/a/README.md', 'docs/guide.md', 'deploy/compose.yaml', 'packages/a/src/gone.ts', 'packages/a/test/gone.test.mjs']) {
    if (path === 'deploy/compose.yaml') { mkdirSync(join(root, 'deploy'), { recursive: true }); writeFileSync(join(root, path), 'services: {}\n'); }
    const result = run(root, [path], SMOKE);
    assert.equal(result.full, undefined, path);
    assert.deepEqual(picked(result), ['packages/a/test/plain.test.mjs'], path);
    assert.equal(result.paths[0].widened, undefined, path);
  }
});

test("the changes are the diff from a merge commit's first parent; a base that names no commit runs every test", (t) => {
  const root = fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'topic');
  writeFileSync(join(root, 'packages/a/src/one.ts'), 'export const one = 2;\n');
  git('commit', '-q', '-am', 'topic');
  git('switch', '-q', 'main');
  // main moves on after the branch point: its change is the base's, not the pull request's.
  writeFileSync(join(root, 'docs/guide.md'), '# Guide, again\n');
  git('commit', '-q', '-am', 'main moves');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'topic');
  const result = affectedSince(root, 'HEAD^1', { smoke: {} });
  assert.deepEqual(result.changed, ['packages/a/src/one.ts']);
  assert.deepEqual(picked(result), ['packages/a/test/one.test.mjs', 'packages/b/test/b.test.mjs']);
  const missing = affectedSince(root, 'no-such-ref', { smoke: {} });
  assert.equal(missing.full, 'the paths changed since no-such-ref cannot be read: no-such-ref names no commit in this checkout');
});

test('the affected pool keeps only the picked units, shared out by time; another pool keeps every unit of its own', (t) => {
  const root = fixture(t);
  const ids = (shards, pool) => Object.values(shards).filter((shard) => shard.pool === pool).flatMap((shard) => shard.units.map((unit) => unit.id)).sort();
  const every = testShards(root);
  assert.deepEqual(ids(every, 'any'), ['file:packages/a/test/one.test.mjs', 'file:packages/a/test/plain.test.mjs', 'file:scripts/tool.test.mjs', 'suite:@fx/w']);
  assert.ok(Object.values(every).every((shard) => shard.affected === false));
  const affected = run(root, ['packages/a/src/one.ts']);
  const shards = testShards(root, { affected });
  assert.deepEqual(ids(shards, 'any'), ['file:packages/a/test/one.test.mjs']);
  assert.deepEqual(ids(shards, 'fixed'), ['file:packages/b/test/b.test.mjs'], 'a pool not marked affected runs every test of its own');
  assert.deepEqual(Object.fromEntries(Object.entries(shards).map(([name, shard]) => [name, [shard.affected, shard.units.length]])), { 'fixed-1': [false, 1], 'any-1': [true, 1], 'any-2': [true, 0] });
});
