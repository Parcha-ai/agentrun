// The barriers a session's writer is asked for (`sync`): an effect that may not run twice runs only once its start is
// durable, and a host's mark of a paid request is awaited before the request leaves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KERNEL_RECORDS, openDrive } from '@parcha/agentrun-kernel/kernel';
import { modelPortFor } from '@parcha/agentrun-kernel';
import { serialWriter } from '@parcha/agentrun-kernel/host';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

/** A writer over memory that logs, in order, each append (by the record kinds it holds) and each sync. */
async function logged(log) {
  const inner = await memorySessionStore().open('run-1');
  return {
    key: inner.key,
    read: () => inner.read(),
    append: async (records) => { log.push(`append ${records.map((r) => r.kind).join(',')}`); await inner.append(records); },
    sync: async () => { log.push('sync'); },
  };
}

test('an effect that may not run twice: its start, then the sync, then the effect, then its end', async () => {
  const log = [];
  const drive = await openDrive({ writer: await logged(log), signal: new AbortController().signal });
  await drive.effect('tool:c1', { name: 'tool.pay', replay: 'never', input: {} }, async () => { log.push('run'); return 'paid'; });
  assert.deepEqual(log, [`append ${KERNEL_RECORDS.start}`, 'sync', 'run', `append ${KERNEL_RECORDS.end}`]);
});

test('a replay-safe effect takes no sync: running it again is harmless', async () => {
  const log = [];
  const drive = await openDrive({ writer: await logged(log), signal: new AbortController().signal });
  await drive.effect('read:c1', { name: 'tool.read', replay: 'safe', input: {} }, async () => { log.push('run'); return 'read'; });
  assert.deepEqual(log, [`append ${KERNEL_RECORDS.start}`, 'run', `append ${KERNEL_RECORDS.end}`]);
});

test('a sync that fails: the effect is not run', async () => {
  const log = [];
  const writer = { ...(await logged(log)), sync: async () => { throw new Error('the disk is gone'); } };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  await assert.rejects(drive.effect('tool:c1', { name: 'tool.pay', replay: 'never', input: {} }, async () => { log.push('run'); }), /the disk is gone/);
  assert.equal(log.includes('run'), false);
});

test('serialWriter passes the sync on, after the appends before it', async () => {
  const log = [];
  const raw = await logged(log);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const slow = { ...raw, append: async (records) => { await held; await raw.append(records); } };
  const serial = serialWriter(slow);
  const appended = serial.append([{ kind: 'a', data: null }]);
  const synced = serial.sync();
  release();
  await Promise.all([appended, synced]);
  assert.deepEqual(log, ['append a', 'sync']);
});

test("a paid request leaves only once the host's request_start handler resolved, and not at all if it rejects", async () => {
  const store = memorySessionStore();
  let finish;
  const handled = new Promise((resolve) => { finish = resolve; });
  const port = await modelPortFor(await store.open('k'), { key: 'k', onEvent: (event) => (event.type === 'request_start' ? handled : undefined) });
  let left = false;
  const admitted = port.models.beforeRequest({ model: 'm' }).then(() => { left = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(left, false, 'waits for the handler');
  finish();
  await admitted;
  assert.equal(left, true);
  const refusing = await modelPortFor(await store.open('k2'), { key: 'k2', onEvent: (event) => (event.type === 'request_start' ? Promise.reject(new Error('the mark failed')) : undefined) });
  await assert.rejects(refusing.models.beforeRequest({ model: 'm' }), /the mark failed/);
});
