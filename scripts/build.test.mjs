// The workspaces' build (scripts/build.mjs) on a two-package workspace: b references a and imports its output.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { build } from './build.mjs';

const options = { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', strict: true, types: [] };

/** Writes a file. A new workspace's files are dated in the past, and an edit a second ahead, so a build never sees an
 *  input and its buildinfo written in the same millisecond. */
function put(root, path, text, at = Date.now() / 1000 + 1) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  utimesSync(file, at, at);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'agentrun-build-'));
  const past = Date.now() / 1000 - 3600;
  const create = (dir, path, text) => put(dir, path, text, past);
  create(root, 'package.json', { private: true, workspaces: ['packages/*'] });
  create(root, 'node_modules/.package-lock.json', { lockfileVersion: 3, packages: {} });
  create(root, 'packages/a/package.json', { name: 'a', scripts: { 'build:after': `node -e "require('fs').writeFileSync('dist/after.txt', 'a')"` } });
  create(root, 'packages/a/tsconfig.json', { compilerOptions: { ...options, composite: true, rootDir: 'src', outDir: 'dist' }, include: ['src'] });
  create(root, 'packages/a/src/index.ts', 'export const answer: number = 42;\n');
  create(root, 'packages/a/src/extra.ts', 'export const extra = 1;\n');
  create(root, 'packages/b/package.json', { name: 'b' });
  create(root, 'packages/b/tsconfig.json', { compilerOptions: { ...options, composite: true, rootDir: 'src', outDir: 'dist' }, include: ['src'], references: [{ path: '../a' }] });
  create(root, 'packages/b/src/index.ts', "import { answer } from '../../a/dist/index.js';\nexport const doubled: number = answer * 2;\n");
  create(root, 'packages/b/tsconfig.test.json', { compilerOptions: { ...options, noEmit: true }, include: ['test'], references: [{ path: '.' }] });
  create(root, 'packages/b/test/types.ts', "import { doubled } from '../src/index.js';\nconst n: number = doubled;\nvoid n;\n");
  return root;
}

/** Runs the build, and returns the projects it compiled. */
function run(root, extra = {}) {
  const lines = [];
  build({ root, log: (line) => lines.push(line), ...extra });
  return lines.filter((line) => /^(built|checked) /.test(line)).map((line) => line.split(' ')[1]);
}

test('a build compiles each project once, in reference order, and a second build compiles nothing', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(run(root), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
  assert.equal(readFileSync(join(root, 'packages/a/dist/after.txt'), 'utf8'), 'a', "a's build:after ran");
  assert.ok(existsSync(join(root, 'packages/b/dist/index.js')));
  assert.ok(!existsSync(join(root, 'packages/a/tsconfig.tsbuildinfo')), 'buildinfo stays out of the package');
  assert.deepEqual(run(root), []);
  assert.deepEqual(run(root, { typecheck: true }), ['packages/b/tsconfig.test.json'], 'typecheck adds the check-only config');
  assert.deepEqual(run(root, { typecheck: true }), []);
});

test('a change that keeps the declarations recompiles only its project; one that changes them recompiles the dependents', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root, { typecheck: true });
  put(root, 'packages/a/src/index.ts', 'export const answer: number = 41 + 1;\n');
  assert.deepEqual(run(root, { typecheck: true }), ['packages/a/tsconfig.json']);
  put(root, 'packages/a/src/index.ts', "export const answer: string = 'x';\n");
  assert.throws(() => run(root, { typecheck: true }), /packages\/b\/tsconfig\.json: TypeScript reported errors/);
  assert.throws(() => run(root, { typecheck: true }), /TypeScript reported errors/, 'the errors stay until the source is fixed');
  put(root, 'packages/a/src/index.ts', 'export const answer: number = 42;\n');
  assert.deepEqual(run(root, { typecheck: true }), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json'], "b's own declarations did not change");
});

test('a new source compiles with the rest, without emptying dist', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root);
  put(root, 'packages/a/src/more.ts', 'export const more = 2;\n');
  const lines = [];
  build({ root, log: (line) => lines.push(line) });
  assert.ok(!lines.some((line) => line.includes('compiling it whole')), lines.join('\n'));
  assert.ok(existsSync(join(root, 'packages/a/dist/more.js')) && existsSync(join(root, 'packages/a/dist/after.txt')));
});

test('a deleted source takes its output with it, and a deleted dist is built again', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root);
  rmSync(join(root, 'packages/a/src/extra.ts'));
  assert.deepEqual(run(root), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json'], 'b is checked against what a has now');
  assert.ok(!existsSync(join(root, 'packages/a/dist/extra.js')) && !existsSync(join(root, 'packages/a/dist/extra.d.ts')), 'no stale module');
  assert.ok(existsSync(join(root, 'packages/a/dist/index.js')) && existsSync(join(root, 'packages/a/dist/after.txt')));
  rmSync(join(root, 'packages/a/dist'), { recursive: true });
  assert.deepEqual(run(root), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
  assert.ok(existsSync(join(root, 'packages/a/dist/index.d.ts')));
  rmSync(join(root, 'packages/b/dist/index.js'));
  assert.deepEqual(run(root), ['packages/b/tsconfig.json'], 'one missing output is enough');
  rmSync(join(root, 'packages/a/dist/index.js'));
  put(root, 'packages/a/src/index.ts', readFileSync(join(root, 'packages/a/src/index.ts'), 'utf8'));
  assert.throws(() => run(root), /packages\/a\/dist\/index\.js is missing after its compile; run the build again/, 'touched, not changed: tsc emits nothing');
  run(root);
  assert.ok(existsSync(join(root, 'packages/a/dist/index.js')));
});

test('a new install starts every project from scratch', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root);
  put(root, 'node_modules/.package-lock.json', { lockfileVersion: 3, packages: { 'node_modules/x': { version: '1.0.0' } } });
  assert.deepEqual(run(root), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
});

test('a program that reads another project without referencing it fails the build, every time, naming the fix', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root);
  put(root, 'packages/b/tsconfig.json', { compilerOptions: { ...options, composite: true, rootDir: 'src', outDir: 'dist' }, include: ['src'] });
  const fix = /packages\/b\/tsconfig\.json reads the output of packages\/a\/tsconfig\.json without referencing it.*add \{ "path": "\.\.\/a\/tsconfig\.json" \}/;
  assert.throws(() => run(root), fix);
  assert.throws(() => run(root), fix, 'not only the first time');
  put(root, 'packages/b/tsconfig.test.json', { compilerOptions: { ...options, noEmit: true }, include: ['test'] });
  assert.throws(() => run(root, { targets: [join(root, 'packages/b/tsconfig.test.json')], typecheck: true }), /tsconfig\.test\.json reads packages\/b\/src\/index\.ts, which it neither includes nor gets from a project it references/);
});

test('a directory selects the workspaces inside it, with the projects they reference', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(run(root, { targets: [join(root, 'packages/a')] }), ['packages/a/tsconfig.json']);
  assert.ok(!existsSync(join(root, 'packages/b/dist')));
  assert.deepEqual(run(root, { targets: [join(root, 'packages/b')] }), ['packages/b/tsconfig.json']);
});

test('a workspace with a tsconfig that is not composite builds with its own script, and its dependents see its changes', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  put(root, 'packages/c/package.json', { name: 'c', dependencies: { a: '*' }, scripts: { build: `node -e "require('fs').rmSync('dist',{recursive:true,force:true})" && node ${JSON.stringify(tsc)} -p tsconfig.json` } });
  put(root, 'packages/c/tsconfig.json', { compilerOptions: { ...options, declaration: true, rootDir: 'src', outDir: 'dist' }, include: ['src'] });
  put(root, 'packages/c/src/index.ts', "import { answer } from '../../a/dist/index.js';\nexport const total: number = answer + 1;\n");
  put(root, 'packages/c/src/old.ts', 'export const old = 1;\n');
  put(root, 'packages/b/package.json', { name: 'b', dependencies: { c: '*' } });
  put(root, 'packages/b/src/total.ts', "import { total } from '../../c/dist/index.js';\nexport const sum: number = total + 1;\n");
  assert.deepEqual(run(root), ['packages/a/tsconfig.json', 'packages/c', 'packages/b/tsconfig.json'], 'c after a, b after c');
  assert.deepEqual(run(root), [], 'nothing changed: c is not built again');

  put(root, 'packages/c/src/index.ts', "import { answer } from '../../a/dist/index.js';\nexport const total: number = answer + 2;\n");
  assert.deepEqual(run(root), ['packages/c'], "same declarations: b stays current");

  rmSync(join(root, 'packages/c/src/old.ts'));
  assert.deepEqual(run(root), ['packages/c']);
  assert.ok(!existsSync(join(root, 'packages/c/dist/old.js')), "c's own build leaves no stale module");

  put(root, 'packages/c/src/index.ts', "export const total: string = 'x';\n");
  assert.throws(() => run(root), /packages\/b\/tsconfig\.json: TypeScript reported errors/, "b is checked against c's new declarations");
  put(root, 'packages/c/src/index.ts', "import { answer } from '../../a/dist/index.js';\nexport const total: number = answer + 3;\n");
  assert.deepEqual(run(root), ['packages/c', 'packages/b/tsconfig.json']);

  rmSync(join(root, 'packages/c/dist/index.js'));
  assert.deepEqual(run(root), ['packages/c'], 'a changed outDir builds it again');
  put(root, 'packages/a/src/index.ts', "export const answer: string = 'x';\n");
  assert.throws(() => run(root), /packages\/c: build \(.*\) exited 2/, "c builds again on a's new declarations, and its own build fails");
});

test('a check-only project is current after a project it references compiles again with the same declarations', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'packages/b/tsconfig.test.json', { compilerOptions: { ...options, noEmit: true }, include: ['test'], references: [{ path: '.' }, { path: '../a' }] });
  run(root, { typecheck: true });
  rmSync(join(root, 'packages/a/dist'), { recursive: true });
  put(root, 'packages/a/src/index.ts', readFileSync(join(root, 'packages/a/src/index.ts'), 'utf8'));
  assert.deepEqual(run(root, { typecheck: true }), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json', 'packages/b/tsconfig.test.json']);
  assert.deepEqual(run(root, { typecheck: true }), [], 'the check found nothing changed, and tsc did not write its buildinfo');
});
