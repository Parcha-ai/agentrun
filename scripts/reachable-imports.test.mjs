import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { reachableImports } from './reachable-imports.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-reachable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
const manifest = JSON.stringify({ name: '@fixture/pkg', exports: {
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './durable': { types: './dist/durable/index.d.ts', import: './dist/durable/index.js' },
  './schema': './schema/fixture.json',
} });

test('an entry reaches what its relative imports and its own package name reach', async t => {
  const root = await fixture(t, {
    'package.json': manifest,
    'dist/durable/index.js': "export * from '@fixture/pkg';\nimport 'node:fs';\nexport { local } from './local.js';\nimport schema from '@fixture/pkg/schema';\n",
    'dist/durable/local.js': "import left from 'left';\nexport const local = left;\n",
    'dist/index.js': "export * from './runner.js';\n",
    'dist/runner.js': "import { agent } from 'agent-only';\nexport const run = async () => (await import('lazy/sub')).default(agent);\n",
    'schema/fixture.json': '{"from":"not-a-module"}\n',
  });
  assert.deepEqual(reachableImports(root, './dist/durable/index.js'), ['agent-only', 'lazy/sub', 'left', 'node:fs']);
  assert.deepEqual(reachableImports(root, './dist/durable/local.js'), ['left']);
});

test('a declaration entry is walked through declarations, self-references included', async t => {
  const root = await fixture(t, {
    'package.json': manifest,
    'dist/durable/index.d.ts': "export type { Run } from '@fixture/pkg';\nexport type { Local } from './local.js';\n",
    'dist/durable/local.d.ts': "export type Local = import('left-types').Left;\n",
    'dist/durable/local.js': "import 'runtime-only';\n",
    'dist/index.d.ts': "export type { Run } from './runner.js';\n",
    'dist/runner.d.ts': "import type { Agent } from 'agent-types';\nexport type Run = (agent: Agent) => void;\n",
    'dist/runner.js': "import 'agent-only';\n",
  });
  assert.deepEqual(reachableImports(root, './dist/durable/index.d.ts'), ['agent-types', 'left-types']);
});

test('a self-reference the package does not export is an error, never a silent stop', async t => {
  const root = await fixture(t, {
    'package.json': manifest,
    'dist/durable/index.js': "export * from '@fixture/pkg/internal';\n",
  });
  assert.throws(() => reachableImports(root, './dist/durable/index.js'), /@fixture\/pkg\/internal is not an export of @fixture\/pkg/);
});
