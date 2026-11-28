import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rename, symlink, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PosixSourceReader } from '../dist/native/source-posix.js';
import { deploymentSource } from '../dist/deployment-source.js';
import { validateSourceSnapshot } from '../dist/source-sync/snapshots.js';

test('descriptor source reads retain custody after a parent is replaced by a link', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-posix-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), outside = join(root, 'outside');
  await mkdir(source); await mkdir(outside);
  await writeFile(join(source, 'file'), 'approved'); await writeFile(join(outside, 'file'), 'outside');
  const info = await stat(source, { bigint: true });
  const expected = [{ path: source, device: String(info.dev), inode: String(info.ino) }];
  const reader = new PosixSourceReader(Date.now() + 30_000);
  t.after(() => reader.close());
  const held = await reader.open(join(source, 'file'), expected);
  await rename(source, join(root, 'held')); await symlink(outside, source);
  const bytes = Buffer.alloc(8);
  assert.equal((await held.read(bytes, 0, 8, 0)).bytesRead, 8);
  assert.equal(bytes.toString(), 'approved');
  await assert.rejects(reader.open(join(source, 'file'), expected), { code: 'source_changed' });
  await held.close();
});

test('descriptor source reader bounds directory inventory and refuses an unapproved root inode', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-posix-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a'), 'a'); await writeFile(join(root, 'b'), 'b');
  const reader = new PosixSourceReader(Date.now() + 30_000);
  t.after(() => reader.close());
  const held = await reader.open(root, []);
  assert.deepEqual((await held.names(2)).sort(), ['a', 'b']);
  await assert.rejects(held.names(1), { code: 'limit' });
  const info = await stat(root, { bigint: true });
  await assert.rejects(reader.open(join(root, 'a'), [{ path: root, device: String(info.dev), inode: String(info.ino + 1n) }]), { code: 'source_changed' });
  await held.close();
});

test('the descriptor broker never executes an interpreter supplied by the source PATH', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-posix-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'python3'), '#!/bin/sh\nprintf "untrusted interpreter\\n"\n', { mode: 0o755 });
  const approved = Buffer.alloc(256 * 1024, 0x61);
  approved.write('captured-tail', approved.length - 13);
  await writeFile(join(root, 'approved'), approved);
  const prior = process.env.PATH;
  process.env.PATH = root;
  try {
    const reader = new PosixSourceReader(Date.now() + 5000);
    try {
      const file = await reader.open(join(root, 'approved'));
      const bytes = Buffer.alloc(approved.length);
      assert.equal((await file.read(bytes, 0, bytes.length, 0)).bytesRead, approved.length);
      assert.deepEqual(bytes, approved, 'a response larger than the pipe buffer arrives completely');
      await file.close();
    } finally { await reader.close(); }
  } finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; }
});

test('cancelling a pending broker request rejects it and closes the helper promptly', { timeout: 5000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-posix-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cancellation = new AbortController(), reader = new PosixSourceReader(Date.now() + 30_000, cancellation.signal);
  try {
    const pending = reader.open(root);
    cancellation.abort();
    await assert.rejects(pending, { code: 'source_unavailable' });
    await assert.rejects(reader.open(root), { code: 'source_unavailable' });
  } finally { await reader.close(); }
});

test('macOS source capture preserves Git, working files, and authored skill assets through the descriptor broker', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-posix-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home'), bin = join(root, 'bin'), skill = join(home, '.pi', 'agent', 'skills', 'inspect');
  await mkdir(project); await mkdir(bin); await mkdir(skill, { recursive: true });
  await writeFile(join(bin, 'pi'), '#!/bin/sh\nprintf "1.5.2\\n"\n', { mode: 0o755 });
  await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({defaultProvider:'openai', defaultModel:'gpt-5.5', defaultProjectTrust:'always'}));
  await writeFile(join(skill, 'SKILL.md'), '---\nname: inspect\ndescription: Inspect this project\n---\nRead reference.txt.\n');
  await writeFile(join(skill, 'reference.txt'), 'authored skill reference');
  await writeFile(join(project, 'project.txt'), 'committed project content');
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM:'1' }, stdio:'pipe' });
  git('init', '-q'); git('add', 'project.txt'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Initial project');
  await writeFile(join(project, 'project.txt'), 'uncommitted project content');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const { snapshot, target } = await deploymentSource({ project, runtime: 'pi', environment: { HOME: home, PATH: bin } });
  assert.equal(target.capabilities.launch, false);
  assert.equal(snapshot.complete, true, JSON.stringify(snapshot.blockers));
  validateSourceSnapshot(snapshot);
  const file = path => { const entry = snapshot.entries.find(item => item.path === path); assert.ok(entry, path); return Buffer.from(snapshot.blobs[entry.sha256], 'base64').toString(); };
  assert.equal(file('project/project.txt'), 'uncommitted project content');
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['inspect']);
  assert.equal(file(`${snapshot.skills[0].path}/reference.txt`), 'authored skill reference');
  assert.ok(snapshot.project.git, 'Git state travels with the project');
});
