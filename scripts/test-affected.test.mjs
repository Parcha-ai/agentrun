import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMOKE, readTestSets, scan, select } from './test-affected.mjs';

const selector = fileURLToPath(new URL('./test-affected.mjs', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

// Two packages: @fx/b depends on @fx/a. a's tests import its dist/ (built from src/ by its tsconfig), its own name through
// "exports", a helper, and a fixture read by a path built from strings.
const FILES = {
  'package.json': JSON.stringify({ name: 'fx', private: true, workspaces: ['packages/*'] }),
  '.github/workflows/ci.yml': 'on: push\n',
  'packages/a/package.json': JSON.stringify({
    name: '@fx/a', version: '1.0.0', type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './extra': { default: './dist/extra.js' } },
    scripts: { build: 'tsc -p tsconfig.json && node scripts/copy.mjs', test: "node --test --test-concurrency=2 'test/*.test.mjs'" },
  }),
  'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' }, include: ['src/**/*.ts'] }),
  'packages/a/scripts/copy.mjs': '// copies nothing\n',
  'packages/a/src/index.ts': "export { top } from './util.js';\nexport type { Shape } from './types.js';\n",
  'packages/a/src/util.ts': "import { deep } from './deep.js';\nexport const top = () => deep();\n",
  'packages/a/src/deep.ts': 'export const deep = () => 1;\n',
  'packages/a/src/types.ts': 'export type Shape = { a: number };\n',
  'packages/a/src/extra.ts': 'export const extra = 2;\n',
  'packages/a/src/lonely.ts': 'export const lonely = 3;\n',
  'packages/a/src/orphan.ts': 'export const orphan = 4;\n',
  'packages/a/test/index.test.mjs': "import { top } from '../dist/index.js';\n",
  'packages/a/test/extra.test.mjs': "import { extra } from '@fx/a/extra';\n",
  'packages/a/test/lonely.test.mjs': "import { lonely } from '../dist/lonely.js';\n",
  'packages/a/test/helper.mjs': "export { deep } from '../dist/deep.js';\n",
  'packages/a/test/via-helper.test.mjs': "import { deep } from './helper.mjs';\n",
  'packages/a/test/reads.test.mjs': "import { readFileSync } from 'node:fs';\nconst name = 'data';\nreadFileSync(new URL(`./fixtures/${name}.json`, import.meta.url));\n// fixtures/data.json\nawait import(`../dist/${name}.js`);\n",
  'packages/a/test/fixtures/data.json': '{}\n',
  // Runs a built file by path, as a child: no import names it. Another file of the same basename is src/deep.ts.
  'packages/a/src/sub/deep.ts': 'export const subDeep = 5;\n',
  'packages/a/test/spawns.test.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [import.meta.dirname + '/../dist/sub/deep.js']);\n",

  'packages/b/package.json': JSON.stringify({
    name: '@fx/b', version: '1.0.0', type: 'module', dependencies: { '@fx/a': '1.0.0' },
    exports: { '.': './dist/index.js' }, scripts: { build: 'tsc -p tsconfig.json', test: "node --test 'test/*.test.mjs'" },
  }),
  'packages/b/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
  'packages/b/src/index.ts': "import { top } from '@fx/a';\nexport const b = () => top();\n",
  'packages/b/test/b.test.mjs': "import { b } from '../dist/index.js';\n",
  'packages/b/test/plain.test.mjs': "import test from 'node:test';\n",
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-affected-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// What `changed` picks: { 'packages/a/test/x.test.mjs': ['import', ...] }, plus the per-path notes.
function picked(root, changed, smoke = {}) {
  const result = select(root, changed, { smoke });
  const files = {};
  for (const suite of result.suites) for (const file of suite.files) files[`${suite.dir}/${file}`] = suite.why[file].map((why) => why.kind);
  return { files, result };
}

test('a source change picks the tests that import it directly and through other files, and no other test', (t) => {
  const root = fixture(t);
  const { files, result } = picked(root, ['packages/a/src/deep.ts']);
  assert.deepEqual(files, {
    'packages/a/test/index.test.mjs': ['import'],
    'packages/a/test/via-helper.test.mjs': ['import'],
    'packages/b/test/b.test.mjs': ['import'],
  });
  const why = (dir, file) => result.suites.find((suite) => suite.dir === dir).why[file][0];
  // The chain runs from the test to the changed file: through a's built index, mapped to its source, and from b's source
  // through the workspace name @fx/a.
  assert.deepEqual(why('packages/a', 'test/index.test.mjs').chain, ['packages/a/test/index.test.mjs', 'packages/a/src/index.ts', 'packages/a/src/util.ts', 'packages/a/src/deep.ts']);
  assert.deepEqual(why('packages/a', 'test/via-helper.test.mjs').chain, ['packages/a/test/via-helper.test.mjs', 'packages/a/test/helper.mjs', 'packages/a/src/deep.ts']);
  assert.deepEqual(why('packages/b', 'test/b.test.mjs').chain, ['packages/b/test/b.test.mjs', 'packages/b/src/index.ts', 'packages/a/src/index.ts', 'packages/a/src/util.ts', 'packages/a/src/deep.ts']);
  assert.deepEqual(result.paths, [{ path: 'packages/a/src/deep.ts', kinds: { import: 3 } }]);
});

test('a package\'s own name resolves through its "exports" to the source', (t) => {
  const root = fixture(t);
  assert.deepEqual(picked(root, ['packages/a/src/extra.ts']).files, { 'packages/a/test/extra.test.mjs': ['import'] });
});

test('a test file change picks itself only', (t) => {
  const root = fixture(t);
  assert.deepEqual(picked(root, ['packages/a/test/lonely.test.mjs']).files, { 'packages/a/test/lonely.test.mjs': ['test'] });
});

test('a package.json, tsconfig or build script change picks that package\'s every test, and no other package\'s', (t) => {
  const root = fixture(t);
  const every = ['extra', 'index', 'lonely', 'reads', 'spawns', 'via-helper'].map((name) => `packages/a/test/${name}.test.mjs`).sort();
  for (const path of ['packages/a/package.json', 'packages/a/tsconfig.json', 'packages/a/scripts/copy.mjs']) {
    const { files } = picked(root, [path]);
    assert.deepEqual(Object.keys(files).sort(), every, path);
    assert.ok(Object.values(files).every((kinds) => kinds.includes('package')), path);
  }
});

test('a workflow change picks the smoke set only, and says why', (t) => {
  const root = fixture(t);
  const { files, result } = picked(root, ['.github/workflows/ci.yml'], { '@fx/b': 'test/plain.test.mjs' });
  assert.deepEqual(files, { 'packages/b/test/plain.test.mjs': ['smoke'] });
  assert.match(result.paths[0].note, /shared root.*smoke set only/);
});

test('a source file run by a built path is picked by the tests that name its path under src/, not by those naming a same-named file', (t) => {
  const root = fixture(t);
  const { files, result } = picked(root, ['packages/a/src/sub/deep.ts']);
  assert.deepEqual(files, { 'packages/a/test/spawns.test.mjs': ['fallback'] });
  assert.deepEqual(result.suites[0].why['test/spawns.test.mjs'][0].chain, ['packages/a/test/spawns.test.mjs', 'packages/a/src/sub/deep.ts']);
});

test('a fixture read by a built path is picked by the tests that name it, as a fallback', (t) => {
  const root = fixture(t);
  const { files, result } = picked(root, ['packages/a/test/fixtures/data.json']);
  assert.deepEqual(files, { 'packages/a/test/reads.test.mjs': ['fallback'] });
  assert.deepEqual(result.suites[0].why['test/reads.test.mjs'][0].chain, ['packages/a/test/reads.test.mjs', 'packages/a/test/fixtures/data.json']);
});

test('a type-only import picks nothing; a code file no test reaches picks the package\'s tests that import by a computed path', (t) => {
  const root = fixture(t);
  // index.ts names types.js only in an `export type`, erased before the test runs.
  for (const path of ['packages/a/src/types.ts', 'packages/a/src/orphan.ts']) {
    const { files, result } = picked(root, [path]);
    assert.deepEqual(files, { 'packages/a/test/reads.test.mjs': ['fallback'] }, path);
    assert.equal(result.suites[0].why['test/reads.test.mjs'][0].computed, true, path);
  }
});

test('a path no test imports or names picks nothing, and says so', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'NOTES.md'), 'notes\n');
  const { files, result } = picked(root, ['NOTES.md']);
  assert.deepEqual(files, {});
  assert.deepEqual(result.paths, [{ path: 'NOTES.md', kinds: {}, note: 'no test imports or names it' }]);
});

test('the parse tree: type-only imports are not imports, a computed import() is flagged, new URL(<relative>, import.meta.url) is one', () => {
  const found = scan([
    "import type { A } from './a.js';",
    "import { type B, type C } from './b.js';",
    "import { type D, e } from './d.js';",
    "export type { F } from './f.js';",
    "const g = new URL('./g.json', import.meta.url);",
    "const h = new URL('https://example.com/h');",
    "await import(`./${name}.js`);",
    "const i = require('./i.cjs');",
    "// import x from './comment.js';",
  ].join('\n'), 'x.ts');
  assert.deepEqual(found, { specifiers: ['./d.js', './g.json', './i.cjs'], computed: true });
});

test('the command line: commands per package from its test script, --json with reasons, --concurrency lowers, --list', (t) => {
  const root = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [selector, ...args], { cwd: root, encoding: 'utf8' });
  const commands = run('--no-smoke', 'packages/a/src/util.ts');
  assert.equal(commands.status, 0, commands.stderr);
  assert.deepEqual(commands.stdout.trim().split('\n'), [
    "npm exec -w @fx/a -c 'node --test --test-concurrency=2 test/index.test.mjs'",
    "npm exec -w @fx/b -c 'node --test test/b.test.mjs'",
  ]);
  assert.match(commands.stderr, /packages\/a\/src\/util\.ts: 2 by import/);
  const capped = run('--no-smoke', '--concurrency', '1', 'packages/a/src/util.ts');
  assert.match(capped.stdout, /node --test --test-concurrency=1 test\/index\.test\.mjs/);
  assert.match(capped.stdout, /node --test --test-concurrency=1 test\/b\.test\.mjs/);
  const json = JSON.parse(run('--no-smoke', '--json', 'packages/a/src/util.ts').stdout);
  assert.deepEqual(json.suites['@fx/a'].files, ['test/index.test.mjs']);
  assert.deepEqual(json.suites['@fx/a'].why['test/index.test.mjs'], [{ kind: 'import', changed: 'packages/a/src/util.ts', chain: ['packages/a/test/index.test.mjs', 'packages/a/src/index.ts', 'packages/a/src/util.ts'] }]);
  const stdin = spawnSync(process.execPath, [selector, '--no-smoke', '--list', '--stdin'], { cwd: root, encoding: 'utf8', input: 'packages/b/test/plain.test.mjs\n' });
  assert.equal(stdin.stdout, 'packages/b/test/plain.test.mjs\n');
  assert.equal(run('--frobnicate').status, 2);
});

test('with no paths given it reads git: every path changed since the merge base with --base, untracked ones too', (t) => {
  const root = fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('branch', 'base');
  writeFileSync(join(root, 'packages/a/src/extra.ts'), 'export const extra = 5;\n');
  git('commit', '-q', '-am', 'change');
  writeFileSync(join(root, 'packages/b/test/new.test.mjs'), "import test from 'node:test';\n");
  const done = spawnSync(process.execPath, [selector, '--no-smoke', '--list', '--base', 'base'], { cwd: root, encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, 'packages/a/test/extra.test.mjs\npackages/b/test/new.test.mjs\n');
  assert.match(done.stderr, /2 changed paths \(\w{10}, the merge base with base\)/);
  const missing = spawnSync(process.execPath, [selector, '--base', 'no-such-ref'], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 2);
});

test('every SMOKE file is a test file of its suite in this repository', () => {
  const sets = readTestSets(repo);
  for (const [name, file] of Object.entries(SMOKE)) {
    const set = sets.find((s) => s.name === name);
    assert.ok(set, `SMOKE names ${name}, which is not a suite`);
    assert.ok(set.files.includes(file), `SMOKE names ${name} ${file}, which is not one of its test files`);
  }
});
