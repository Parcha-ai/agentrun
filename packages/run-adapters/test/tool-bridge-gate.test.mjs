// The tool bridge asks the host's gate (SessionIO.gate) about a call before anything of it is written: before the flush a
// call that runs at most once takes (beforeNever) and before its intent (the effect's start record). allow runs it; a
// deny answers the model with the host's words and runs nothing; a park holds the call (nothing of it is written) until
// the session's signal is aborted. A call the log already finished is not asked again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

/** A drive on a fresh session, and what was written to it. */
async function driveOf(key, signal = new AbortController().signal) {
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open(key), signal });
  return { drive, records: () => store.read(key) };
}

const starts = async (records) => (await records()).filter((record) => record.kind === 'kernel.start');

function payTool(log) {
  return { name: 'pay', description: 'Pay.', inputSchema: { type: 'object' }, replay: 'never', execute: async (args) => { log.push(['ran', args]); return 'paid'; } };
}

test('the gate is asked before the flush and before the intent; allow runs the call', async () => {
  const { drive, records } = await driveOf('gate-allow');
  const log = [];
  const gate = async (call) => {
    log.push(['gate', call, (await starts(records)).length]);
    return 'allow';
  };
  const bridge = toolBridge(drive, [payTool(log)], { gate, beforeNever: async () => { log.push(['flush']); } });
  const result = await bridge.call('pay', { amount: 3 }, 'c1');
  assert.deepEqual(result, { text: 'paid', isError: false });
  assert.deepEqual(log, [['gate', { callId: 'c1', tool: 'pay', args: { amount: 3 } }, 0], ['flush'], ['ran', { amount: 3 }]], 'gate, then flush, then the call; nothing written when the gate was asked');
  assert.equal((await starts(records)).length, 1, 'the intent once the gate allowed it');
});

test("a deny answers the model in the host's words and writes and runs nothing", async () => {
  const { drive, records } = await driveOf('gate-deny');
  const log = [];
  const bridge = toolBridge(drive, [payTool(log)], { gate: async () => ({ deny: 'Permission denied: pay is set to deny.' }), beforeNever: async () => { log.push(['flush']); } });
  const result = await bridge.call('pay', {}, 'c2');
  assert.deepEqual(result, { text: 'Permission denied: pay is set to deny.', isError: true });
  assert.deepEqual(log, [], 'no flush, no call');
  assert.deepEqual(await starts(records), [], 'no intent');
});

test("a park holds the call, writing and running nothing, until the session's signal is aborted", async () => {
  const controller = new AbortController();
  const { drive, records } = await driveOf('gate-park', controller.signal);
  const log = [];
  let asked;
  const askedOnce = new Promise((resolve) => (asked = resolve));
  const bridge = toolBridge(drive, [payTool(log)], { gate: async () => { asked(); return { park: true }; }, beforeNever: async () => { log.push(['flush']); } });
  let settled = false;
  const call = bridge.call('pay', {}, 'c3').finally(() => { settled = true; });
  call.catch(() => undefined);
  // The gate is asked, or the call settles without it: either way this test goes on, never waiting forever.
  const first = await Promise.race([askedOnce.then(() => 'asked'), call.then(() => 'settled', () => 'settled')]);
  assert.equal(first, 'asked', 'the gate was asked before the call settled');
  await Promise.resolve();
  assert.equal(settled, false, 'held while the run is parked');
  assert.deepEqual(await starts(records), [], 'no intent while parked');
  controller.abort();
  await assert.rejects(call, /parked/);
  assert.deepEqual(log, [], 'never ran');
});

test('a call the log already finished is not asked about again', async () => {
  const { drive } = await driveOf('gate-memo');
  const log = [];
  let asks = 0;
  const gate = async () => { asks += 1; return 'allow'; };
  const tool = { ...payTool(log), replay: 'safe' };
  await toolBridge(drive, [tool], { gate }).call('pay', {}, 'c4');
  const again = await toolBridge(drive, [tool], { gate }).call('pay', {}, 'c4');
  assert.deepEqual(again, { text: 'paid', isError: false });
  assert.equal(asks, 1, 'asked once');
  assert.equal(log.length, 1, 'ran once');
});

test('without a gate, the bridge runs the call as before', async () => {
  const { drive } = await driveOf('gate-none');
  const log = [];
  assert.deepEqual(await toolBridge(drive, [payTool(log)]).call('pay', {}, 'c5'), { text: 'paid', isError: false });
  assert.equal(log.length, 1);
});
