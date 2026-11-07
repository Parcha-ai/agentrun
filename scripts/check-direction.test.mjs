// Imports follow the layer direction: this tree passes with its listed exceptions, a planted wrong edge fails naming its
// file:line and both layers, and an exception that no longer occurs fails too.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { directionProblems } from './check-direction.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'agentrun-direction-'));
after(() => rm(scratch, { recursive: true, force: true }));

const layers = { protocol: ['packages/p'], kernel: ['packages/k'], 'plug-in': ['packages/g'], subsystem: ['packages/s'], server: ['packages/v'], surface: ['apps/c'] };
const may = { protocol: [], kernel: ['protocol'], 'plug-in': ['protocol', 'kernel'], subsystem: ['protocol', 'kernel', 'subsystem'], server: Object.keys(layers), surface: [] };

let made = 0;
/** A workspace with one package per layer, and `files` ({ path: text }) written over it. */
async function workspace(files = {}) {
  const dir = join(scratch, `w${made += 1}`);
  const base = {
    'packages/v/src/files.ts': 'export const TOKEN_FILE = ".token";\nexport const RUN_META = "serve.json";\n',
    'packages/g/src/index.ts': "import { run } from '@x/k';\nimport type { Wire } from '@x/p';\n",
    'apps/c/src/main.ts': "fetch('/api/v2/runs');\n",
  };
  for (const layer of Object.values(layers)) for (const pkg of layer) base[`${pkg}/package.json`] = JSON.stringify({ name: `@x/${pkg.split('/')[1]}` }, null, 2);
  for (const [path, text] of Object.entries({ ...base, ...files })) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}
const check = async (files, exceptions = []) => directionProblems(await workspace(files), { layers, may, exceptions });

test('this tree follows the layer direction, with its listed exceptions', async () => {
  assert.deepEqual(await directionProblems(root), []);
});

test('a planted workspace with only allowed edges passes', async () => {
  assert.deepEqual(await check({ 'packages/s/src/a.ts': "import '@x/k';\nimport { b } from '@x/p/sub';\nexport * from '../../s/src/b.ts';\n" }), []);
});

test('a wrong edge fails with its file:line and both layers', async () => {
  const problems = await check({ 'packages/k/src/a.ts': "// the kernel\n\nimport { serve } from '@x/v';\n" });
  assert.deepEqual(problems, ["packages/k/src/a.ts:3: packages/k (kernel) reaches packages/v (server) by '@x/v'; a kernel may reach only protocol"]);
});

test('every way to reach a package is an edge', async () => {
  const ways = {
    'export-from': ['packages/p/src/a.ts', "export { x } from '@x/k';"],
    'a dynamic import of a subpath': ['packages/p/src/a.ts', "await import('@x/k/sub');"],
    'import.meta.resolve': ['packages/p/src/a.mjs', "import.meta.resolve('@x/k/package.json');"],
    require: ['packages/p/src/a.cjs', "const k = require('@x/k');"],
    'a constant later imported': ['packages/p/src/a.mjs', 'const NAME = "@x/k";'],
    'a relative path into another package': ['packages/k/src/a.ts', "import { s } from '../../s/src/index.ts';"],
    'a tsconfig path alias': ['apps/c/tsconfig.json', '{ "compilerOptions": { "paths": { "@s/*": ["../../packages/s/src/*"] } } }'],
    'a dependency': ['packages/k/package.json', JSON.stringify({ name: '@x/k', dependencies: { '@x/g': '1.0.0' } })],
    'a peer dependency': ['packages/k/package.json', JSON.stringify({ name: '@x/k', peerDependencies: { '@x/s': '1.0.0' } })],
    "a surface naming the server's data file": ['apps/c/src/cli.mjs', 'readFileSync(join(data, ".token"));'],
  };
  for (const [way, [file, text]] of Object.entries(ways)) {
    const problems = await check({ [file]: text });
    assert.equal(problems.length, 1, `${way}: ${problems.join('; ')}`);
    assert.match(problems[0], new RegExp(`^${file.replace('.', '\\.')}:1: `), way);
  }
});

test('tests, fixtures, vendor, dist and prose are not read', async () => {
  assert.deepEqual(await check({
    'packages/k/src/a.test.ts': "import '@x/v';",
    'packages/k/test/a.ts': "import '@x/v';",
    'packages/k/fixtures/a.ts': "import '@x/v';",
    'packages/k/vendor/a.js': "import '@x/v';",
    'packages/k/dist/a.js': "import '@x/v';",
    'packages/k/package.json': JSON.stringify({ name: '@x/k', devDependencies: { '@x/v': '1.0.0' } }),
    'packages/k/src/b.ts': '/** Run it with `@x/v`, which serves "serve.json". */\nexport const a = 1;\n',
  }), []);
});

test('an exception covers its edges exactly: unused, short or over, it fails', async () => {
  const files = { 'packages/k/src/a.ts': "import { serve } from '@x/v';\nimport type { Serve } from '@x/v';\n" };
  const reason = ['why', 'the fix'];
  assert.deepEqual(await check(files, [['packages/k/src/a.ts', 'packages/v', 2, ...reason]]), []);
  assert.deepEqual(await check({}, [['packages/k/src/a.ts', 'packages/v', 2, ...reason]]), ['exception packages/k/src/a.ts -> packages/v no longer occurs: delete it from EXCEPTIONS']);
  assert.deepEqual(await check(files, [['packages/k/src/a.ts', 'packages/v', 3, ...reason]]), ['exception packages/k/src/a.ts -> packages/v allows 3, 2 found: lower its count in EXCEPTIONS']);
  const over = await check(files, [['packages/k/src/a.ts', 'packages/v', 1, ...reason]]);
  assert.equal(over.length, 2);
  assert.match(over[1], /^packages\/k\/src\/a\.ts:2: .*\(exception packages\/k\/src\/a\.ts -> packages\/v allows 1, 2 found\)$/);
});

test('a workspace with no layer, or a layer naming no workspace, fails', async () => {
  const problems = await check({ 'packages/new/package.json': '{"name":"@x/new"}' });
  assert.deepEqual(problems, ['packages/new has no layer: add it to LAYERS in scripts/check-direction.mjs']);
  const gone = await directionProblems(await workspace(), { layers: { ...layers, subsystem: ['packages/s', 'packages/gone'] }, may, exceptions: [] });
  assert.deepEqual(gone, ['LAYERS names packages/gone, which is not a workspace: delete it']);
});
