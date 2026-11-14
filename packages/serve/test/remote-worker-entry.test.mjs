import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bridge = new URL('../dist/native/remote-worker-bridge.js', import.meta.url);
const request = JSON.stringify({ id: 'entry-check', type: 'unsupported' }) + '\n';
const run = (args) => {
  const result = spawnSync(process.execPath, args, { input: request, encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test('a remote worker invoked through a symlink dispatches its JSONL requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-bridge-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'remote-worker.mjs');
  await symlink(fileURLToPath(bridge), entry);
  const expected = { id: 'entry-check', error: 'Unsupported remote operation.' };
  assert.deepEqual(JSON.parse(run([fileURLToPath(bridge)])), expected);
  assert.deepEqual(JSON.parse(run([entry])), expected);
});

test('importing the remote worker exports its API without starting its input loop', () => {
  const source = `const before = process.stdin.listenerCount('data');
const { runRemoteWorkerBridge } = await import(${JSON.stringify(bridge.href)});
console.log(JSON.stringify({ api: typeof runRemoteWorkerBridge, listeners: process.stdin.listenerCount('data') - before }));`;
  assert.deepEqual(JSON.parse(run(['--input-type=module', '--eval', source])), { api: 'function', listeners: 0 });
});
