// The barriers a session's writer is asked for (`sync`): an effect that may not run twice runs only once its start is
// durable, and a host's mark of a paid request is awaited before the request leaves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KERNEL_RECORDS, openDrive } from '@parcha/agentrun-kernel/kernel';
import { modelPortFor, RUNNER_RECORDS } from '@parcha/agentrun-kernel';
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

test("a request whose start mark is refused is booked withdrawn and never taken for an open one: the next answer is the next request's", async () => {
  const store = memorySessionStore();
  let refuse = true;
  const port = await modelPortFor(await store.open('k'), { key: 'k', onEvent: (event) => (event.type === 'request_start' && refuse ? Promise.reject(new Error('the mark failed')) : undefined) });
  await assert.rejects(port.models.beforeRequest({ model: 'm' }), /the mark failed/);
  refuse = false;
  const second = await port.models.beforeRequest({ model: 'm' });
  await port.models.responded({ id: 'resp-2' });
  const records = await (await store.open('k')).read();
  const refused = records.find((r) => r.kind === RUNNER_RECORDS.turn && r.data.turn === 1);
  assert.deepEqual(refused?.data, { turn: 1, usd: 0, unsent: true }, 'the refused request is booked withdrawn at $0');
  const response = records.find((r) => r.kind === RUNNER_RECORDS.response);
  assert.equal(response?.data.turn, second.turn, 'a ticketless answer is the open request, not the refused one');
  assert.equal(second.turn, 2);
});

test("a stop that lands while the start mark is being made: the request does not leave, it is booked withdrawn at $0, and the host is told it ended at $0", async () => {
  const store = memorySessionStore();
  let stop;
  const events = [];
  let release;
  const marking = new Promise((resolve) => { release = resolve; });
  const port = await modelPortFor(await store.open('k'), {
    key: 'k',
    stopped: () => stop,
    onEvent: (event) => { events.push(event.type === 'request_end' ? { type: event.type, turn: event.turn, usd: event.usage.usd } : { type: event.type, turn: event.turn }); return event.type === 'request_start' ? marking : undefined; },
  });
  const admitted = port.models.beforeRequest({ model: 'm' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop = new Error('cancelled');
  release();
  await assert.rejects(admitted, /cancelled/);
  const records = await (await store.open('k')).read();
  assert.deepEqual(records.find((r) => r.kind === RUNNER_RECORDS.turn)?.data, { turn: 1, usd: 0, unsent: true });
  assert.deepEqual(events, [{ type: 'request_start', turn: 1 }, { type: 'request_end', turn: 1, usd: 0 }]);
});

test('a writer with no sync: an effect that may not run twice is refused, with words, before it runs', async () => {
  const log = [];
  const { sync: _sync, ...writer } = await logged(log);
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  await assert.rejects(drive.effect('tool:c1', { name: 'tool.pay', replay: 'never', input: {} }, async () => { log.push('run'); }), /has no sync to make its start durable/);
  assert.equal(log.includes('run'), false, 'the effect never ran');
});
