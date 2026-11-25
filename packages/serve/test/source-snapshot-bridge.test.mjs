import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { nativeFixture } from './native-fixtures/setup.mjs';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';

function bridge(t, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/native/remote-worker-bridge.js', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let next = 0;
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line), entry = waiting.get(message.id); if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); } });
  t.after(async () => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); });
  return async (type, body = {}) => new Promise((resolve, reject) => { const id = `snapshot-${++next}`; const timer = setTimeout(() => reject(new Error('Local snapshot bridge timed out')), 10000); waiting.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ id, type, ...body }) + '\n'); });
}

for (const runtime of ['codex', 'claude-code']) test(`${runtime}: local bridge exports exact authored bytes without sign-in or a native prompt`, async t => {
  const f = await nativeFixture(t), call = bridge(t, { ...f.env, NATIVE_TEST_AUTH: 'no' });
  const name = runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  await f.put(join(f.project, name), 'Keep this exact authored policy.\n');
  const target = (await call('discover', { payload: { project: f.project, runtime } })).result.targets.find(target => target.selector.kind === 'project');
  const exported = await call('source-snapshot', { target, payload: { authorized_roots: [f.project, f.home] } });
  assert.equal(exported.error, undefined, JSON.stringify(exported));
  const snapshot = exported.result;
  assert.equal(snapshot.digest, sourceSnapshotDigest(snapshot), 'the bridge never redacts an already-digested manifest');
  const entry = snapshot.entries.find(entry => entry.path === `project/${name}`);
  assert.equal(Buffer.from(snapshot.blobs[entry.sha256], 'base64').toString(), 'Keep this exact authored policy.\n');
  assert.deepEqual((await f.calls()).filter(call => call.args.includes('--print') || call.args.includes('exec') || call.args.includes('login') || call.args.includes('auth')), []);
  const refused = await call('source-snapshot', { target: { ...target, machine_id: 'another-machine' }, payload: { authorized_roots: [f.project, f.home] } });
  assert.equal(refused.code, 'source_unavailable');
  assert.equal(refused.error, 'The approved source snapshot could not be captured.');
  assert.equal(refused.result, undefined);
});


test('local connector-held credentials are refused before snapshot hashing and never echoed', async t => {
  const f = await nativeFixture(t), call = bridge(t, { ...f.env, NATIVE_TEST_AUTH: 'no' });
  const token = 'ar_connector_' + 'test-only-fixture-current-credential';
  await f.put(join(f.project, 'copied-output.txt'), token + '\n');
  const target = (await call('discover', { payload: { project: f.project, runtime: 'codex' } })).result.targets.find(target => target.selector.kind === 'project');
  const exported = await call('source-snapshot', { target, payload: { authorized_roots: [f.project, f.home], secret_values: [token] } });
  assert.equal(exported.error, undefined, JSON.stringify(exported));
  const snapshot = exported.result;
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.blockers.some(item => item.code === 'secret_content'));
  assert.equal(snapshot.entries.some(item => item.path === 'project/copied-output.txt'), false);
  assert.equal(Object.values(snapshot.blobs).some(value => Buffer.from(value, 'base64').includes(Buffer.from(token))), false);
  assert.equal(JSON.stringify(exported).includes(token), false);
  assert.equal(snapshot.digest, sourceSnapshotDigest(snapshot), 'refusal precedes hashing; no bytes are silently redacted');
});

for (const secret_values of [['x'.repeat(8193)], ['é'.repeat(4097)], Array(9).fill('x'.repeat(8192)), Array(17).fill('test-only-fixture'), [null], 'test-only-fixture'])
  test('local bridge rejects malformed or oversized held-value envelopes without echoing them', async t => {
    const f = await nativeFixture(t), call = bridge(t, { ...f.env, NATIVE_TEST_AUTH: 'no' });
    const target = (await call('discover', { payload: { project: f.project, runtime: 'codex' } })).result.targets.find(target => target.selector.kind === 'project');
    const refused = await call('source-snapshot', { target, payload: { authorized_roots: [f.project, f.home], secret_values } });
    assert.equal(refused.code, 'source_unavailable');
    assert.equal(refused.error, 'The approved source snapshot could not be captured.');
    assert.equal(refused.result, undefined);
    assert.equal(JSON.stringify(refused).includes('test-only-fixture'), false);
  });
