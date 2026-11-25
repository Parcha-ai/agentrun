import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockedVersions, npmTree, parseKey, readLock, snapshotKey } from './pnpm-lock.mjs';

test('a key and a reference read as pnpm writes them: peers dropped, an alias kept, a workspace link none', () => {
  assert.deepEqual(parseKey('@scope/a@1.2.3(peer@2.0.0)'), { name: '@scope/a', version: '1.2.3' });
  assert.equal(snapshotKey('a', '1.0.0(b@2.0.0)'), 'a@1.0.0(b@2.0.0)');
  assert.equal(snapshotKey('codex-linux', '@openai/codex@0.1.0-linux'), '@openai/codex@0.1.0-linux');
  assert.equal(snapshotKey('dsl', 'link:../dsl'), null);
});

// The root develops on lib 2; packages/old pins lib 1, which nests under it; lib 2 depends on util 1 and its peer host, an
// aliased dependency resolves another package, and packages/old links packages/new.
test('npmTree lays the lock out as npm would: hoisted, nested where a version differs, peers left to the host, aliases named', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-pnpm-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [dir, name] of [['.', 'root'], ['packages/old', 'old'], ['packages/new', 'new']]) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  }
  await writeFile(join(root, 'pnpm-lock.yaml'), JSON.stringify({
    lockfileVersion: '9.0',
    importers: {
      '.': { devDependencies: { lib: { specifier: '2.0.0', version: '2.0.0(host@1.0.0)' }, host: { specifier: '1.0.0', version: '1.0.0' } } },
      'packages/old': { dependencies: { lib: { specifier: '1.0.0', version: '1.0.0' }, new: { specifier: '0.0.0', version: 'link:../new' }, alias: { specifier: 'npm:real@3.0.0', version: 'real@3.0.0' } } },
      'packages/new': {},
    },
    packages: { 'lib@1.0.0': {}, 'lib@2.0.0': { peerDependencies: { host: '*' }, resolution: { integrity: 'sha512-lib2' } }, 'host@1.0.0': {}, 'util@1.0.0': {}, 'real@3.0.0': {} },
    snapshots: { 'lib@1.0.0': {}, 'lib@2.0.0(host@1.0.0)': { dependencies: { util: '1.0.0', host: '1.0.0' } }, 'host@1.0.0': {}, 'util@1.0.0': {}, 'real@3.0.0': {} },
  }));
  const tree = npmTree(root);
  assert.deepEqual(tree['node_modules/lib'], { version: '2.0.0', integrity: 'sha512-lib2', dependencies: { util: '1.0.0' }, peerDependencies: { host: '*' } });
  assert.equal(tree['node_modules/util'].version, '1.0.0');
  assert.equal(tree['packages/old/node_modules/lib'].version, '1.0.0');
  assert.deepEqual(tree['node_modules/alias'], { version: '3.0.0', name: 'real' });
  assert.deepEqual(tree['node_modules/new'], { resolved: 'packages/new', link: true });
  assert.equal(tree[''].name, 'root');
  assert.equal(tree['packages/old'].name, 'old');
});

test('a lockfile pnpm 9+ did not write is refused, not misread', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-pnpm-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '6.0'\n");
  assert.throws(() => readLock(root), /lockfileVersion 6\.0/);
  await writeFile(join(root, 'pnpm-lock.yaml'), "---\npackageManagerDependencies: {}\n---\nlockfileVersion: '9.0'\npackages:\n  a@1.0.0: {}\n  a@1.1.0: {}\n");
  assert.deepEqual(lockedVersions(readLock(root), 'a'), ['1.0.0', '1.1.0'], 'the project is the last document');
});
