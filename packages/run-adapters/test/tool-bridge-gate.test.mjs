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
  // Marked refused: a nested call (a script's, tools_call's) tells a refusal from a tool's own error by it.
  assert.deepEqual(result, { text: 'Permission denied: pay is set to deny.', isError: true, refused: true });
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

test('a replay-safe call a crash cut, asked about again by the next drive, is asked as replayed (it may have been sent); a call never started is not', async () => {
  const store = memorySessionStore();
  // The first drive starts the call and is lost with it in flight: its start is in the log, with no end.
  const first = await openDrive({ writer: await store.open('gate-replayed'), signal: new AbortController().signal });
  const peek = { name: 'peek', description: 'Peek.', inputSchema: { type: 'object' }, replay: 'safe', execute: () => new Promise(() => {}) };
  void toolBridge(first, [peek]).call('peek', { q: 'x' }, 'cut');
  await new Promise((resolve) => setImmediate(resolve));
  const second = await openDrive({ writer: await store.open('gate-replayed'), signal: new AbortController().signal });
  const asked = [];
  const bridge = toolBridge(second, [{ ...peek, execute: async () => 'seen' }], { gate: async (call) => (asked.push(call), { deny: 'Permission denied: peek is set to deny.' }) });
  await bridge.call('peek', { q: 'x' }, 'cut');
  await bridge.call('peek', { q: 'y' }, 'fresh');
  assert.deepEqual(asked, [
    { callId: 'cut', tool: 'peek', args: { q: 'x' }, replayed: true },
    { callId: 'fresh', tool: 'peek', args: { q: 'y' } },
  ]);
});

test('a nesting call a crash cut after it fixed a value, asked about again by the next drive, is asked as replayed; one that fixed nothing, or never started, is not', async () => {
  const store = memorySessionStore();
  // The first drive runs `outer`: its first value fixed (a model node's answer, recorded under the call), then lost in
  // flight. `idle` is let go too, but is lost before it fixed anything.
  const first = await openDrive({ writer: await store.open('nesting-replayed'), signal: new AbortController().signal });
  let fixed;
  const once = new Promise((resolve) => (fixed = resolve));
  const nesting = (name, work) => ({ name, description: 'Nests.', inputSchema: { type: 'object' }, replay: 'safe', nests: true, execute: work });
  void toolBridge(first, [nesting('outer', async (_args, io) => { await io.nested.memo('node:a', async () => 'answer'); fixed(); return new Promise(() => {}); })]).call('outer', {}, 'cut');
  void toolBridge(first, [nesting('idle', () => new Promise(() => {}))]).call('idle', {}, 'idle');
  await once;
  const second = await openDrive({ writer: await store.open('nesting-replayed'), signal: new AbortController().signal });
  const asked = [];
  const gate = async (call) => (asked.push(call), { deny: 'Permission denied: set to deny.' });
  const bridge = toolBridge(second, [nesting('outer', async () => 'ran'), nesting('idle', async () => 'ran')], { gate });
  await bridge.call('outer', {}, 'cut');
  await bridge.call('idle', {}, 'idle');
  await bridge.call('outer', {}, 'fresh');
  // A call whose id is a prefix of the cut one's (`cu`) is another call.
  await bridge.call('outer', {}, 'cu');
  assert.deepEqual(asked, [
    { callId: 'cut', tool: 'outer', args: {}, replayed: true },
    { callId: 'idle', tool: 'idle', args: {} },
    { callId: 'fresh', tool: 'outer', args: {} },
    { callId: 'cu', tool: 'outer', args: {} },
  ]);
});

test('a deferred tool is not listed to the model, yet a nested call and call() run it by name', async () => {
  const { drive } = await driveOf('deferred');
  const log = [];
  const hidden = { ...payTool(log), name: 'hidden', deferred: true };
  const outer = { name: 'outer', description: 'Calls hidden.', inputSchema: { type: 'object' }, replay: 'safe', nests: true, execute: async (_args, io) => (await io.nested.call('hidden', { n: 1 }, 'call')).text };
  const bridge = toolBridge(drive, [payTool(log), hidden, outer]);
  assert.deepEqual(bridge.tools.map((tool) => tool.name), ['pay', 'outer'], 'the model is listed the others');
  assert.equal((await bridge.call('outer', {}, 'c5')).text, 'paid', 'a nested call ran the deferred tool');
  assert.equal((await bridge.call('hidden', {}, 'c6')).text, 'paid', 'and so does a call by name');
  assert.equal(log.length, 2);
});

test("a nested call given a signal of its own runs on it: one already aborted never reaches the tool's work, while the outer call goes on", async () => {
  const { drive } = await driveOf('nested-signal');
  const log = [];
  const work = { name: 'work', description: 'Works.', inputSchema: { type: 'object' }, replay: 'safe', execute: async (_args, io) => { log.push(io.signal.aborted ? 'cut' : 'whole'); return 'done'; } };
  const outer = {
    name: 'outer', description: 'Calls work on a cut signal.', inputSchema: { type: 'object' }, replay: 'safe', nests: true,
    execute: async (_args, io) => {
      const own = new AbortController();
      own.abort(new Error('a sibling failed'));
      await io.nested.call('work', {}, 'cut', own.signal).catch(() => undefined);
      return 'outer went on';
    },
  };
  const bridge = toolBridge(drive, [work, outer]);
  assert.equal((await bridge.call('outer', {}, 'c7')).text, 'outer went on');
  assert.ok(!log.includes('whole'), `the nested call's work never ran on the outer call's signal alone: ${JSON.stringify(log)}`);
});
