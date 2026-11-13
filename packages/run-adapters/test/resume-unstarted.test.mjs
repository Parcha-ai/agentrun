// resumeUnstartedCalls: on a CLI's resume, a call its transcript left dangling that never reached its intent (no effect
// for tool:<callId> in the drive's records, the session's own on the run's journal) goes through the tool bridge, the
// host's gate first, then its intent, the call and its result, all journaled, and only then is it settled into the CLI's
// transcript (`settle`). A call with an intent (cut off, released or ended) is left to the CLI's own recovery: never run
// again here. A gate that parks writes nothing and settles nothing, and the call keeps its id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { resumeUnstartedCalls, toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const starts = (records, callId) => records.filter((record) => record.kind === 'kernel.start' && record.data?.key === `tool:${callId}`);

/** A tool that records its runs. */
function lookupTool(ran, replay = 'never') {
  return { name: 'lookup', description: 'Look it up.', inputSchema: { type: 'object' }, replay, execute: async (args) => { ran.push(args); return `found ${args.q}`; } };
}

test('a dangling call that never started: the gate, its intent, the call and its result, then it is settled', async () => {
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open('s1'), signal: new AbortController().signal });
  const ran = [];
  const order = [];
  const gate = async (call) => {
    order.push(['gate', call, starts(await store.read('s1'), call.callId).length]);
    return 'allow';
  };
  const bridge = toolBridge(drive, [lookupTool(ran)], { gate });
  const settled = [];
  await resumeUnstartedCalls(drive, bridge, [{ callId: 'c1', tool: 'lookup', args: { q: 'x' } }], async (call, outcome) => {
    settled.push([call.callId, outcome, starts(await store.read('s1'), call.callId).length]);
  });
  assert.deepEqual(order, [['gate', { callId: 'c1', tool: 'lookup', args: { q: 'x' } }, 0]], 'asked first, before any intent');
  assert.deepEqual(ran, [{ q: 'x' }], 'ran once');
  assert.deepEqual(settled, [['c1', { text: 'found x', isError: false }, 1]], 'settled after its intent and result were journaled');
});

test('a deny is settled in the host words, and nothing ran or was written', async () => {
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open('s2'), signal: new AbortController().signal });
  const ran = [];
  const bridge = toolBridge(drive, [lookupTool(ran)], { gate: async () => ({ deny: 'Permission denied: lookup is set to deny.' }) });
  const settled = [];
  await resumeUnstartedCalls(drive, bridge, [{ callId: 'c2', tool: 'lookup', args: {} }], async (call, outcome) => { settled.push([call.callId, outcome]); });
  assert.deepEqual(settled, [['c2', { text: 'Permission denied: lookup is set to deny.', isError: true }]]);
  assert.deepEqual(ran, []);
  assert.deepEqual(starts(await store.read('s2'), 'c2'), []);
});

test('a call with an intent is never run again here, whether it was cut off, released or ended', async () => {
  const store = memorySessionStore();
  // First drive: two calls start and never end (the process died), one ends.
  const first = await openDrive({ writer: await store.open('s3'), signal: new AbortController().signal });
  const ran = [];
  const hang = { name: 'lookup', description: 'Hangs.', inputSchema: { type: 'object' }, replay: 'never', execute: () => new Promise(() => {}) };
  const hangSafe = { ...hang, name: 'peek', replay: 'safe' };
  const done = lookupTool(ran, 'safe');
  const bridge1 = toolBridge(first, [hang, hangSafe, { ...done, name: 'done' }], { serial: false });
  void bridge1.call('lookup', {}, 'cut');
  void bridge1.call('peek', {}, 'released');
  await bridge1.call('done', { q: 'y' }, 'ended');
  await new Promise((resolve) => setImmediate(resolve));
  // Second drive on the same session: the cut-off intents are resolved by its open; none is run again here.
  const second = await openDrive({ writer: await store.open('s3'), signal: new AbortController().signal });
  let asked = 0;
  const bridge2 = toolBridge(second, [lookupTool(ran), { ...lookupTool(ran, 'safe'), name: 'peek' }, { ...done, name: 'done' }], { gate: async () => { asked += 1; return 'allow'; } });
  const settled = [];
  await resumeUnstartedCalls(second, bridge2, [
    { callId: 'cut', tool: 'lookup', args: {} },
    { callId: 'released', tool: 'peek', args: {} },
    { callId: 'ended', tool: 'done', args: { q: 'y' } },
  ], async (call) => { settled.push(call.callId); });
  assert.equal(asked, 0, 'no gate asked');
  assert.deepEqual(settled, [], 'none settled here: the CLI recovers them as today');
  assert.deepEqual(ran, [{ q: 'y' }], 'only the call that ended in the first drive ever ran');
});

test('a gate that parks on resume writes nothing and settles nothing; the call keeps its id', async () => {
  const controller = new AbortController();
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open('s4'), signal: controller.signal });
  const ran = [];
  const asked = [];
  const bridge = toolBridge(drive, [lookupTool(ran)], { gate: async (call) => { asked.push(call.callId); queueMicrotask(() => controller.abort()); return { park: true }; } });
  const settled = [];
  await assert.rejects(resumeUnstartedCalls(drive, bridge, [{ callId: 'toolu_42', tool: 'lookup', args: {} }], async (call) => { settled.push(call.callId); }), /parked/);
  assert.deepEqual(asked, ['toolu_42'], 'asked under the id the model gave it');
  assert.deepEqual(settled, []);
  assert.deepEqual(ran, []);
  assert.deepEqual(starts(await store.read('s4'), 'toolu_42'), []);
});

test('several dangling calls are taken in their order, each settled before the next is asked', async () => {
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open('s5'), signal: new AbortController().signal });
  const events = [];
  const bridge = toolBridge(drive, [lookupTool([])], { gate: async (call) => { events.push(`gate ${call.callId}`); return 'allow'; } });
  await resumeUnstartedCalls(drive, bridge, [{ callId: 'a', tool: 'lookup', args: { q: 1 } }, { callId: 'b', tool: 'lookup', args: { q: 2 } }], async (call) => { events.push(`settle ${call.callId}`); });
  assert.deepEqual(events, ['gate a', 'settle a', 'gate b', 'settle b']);
});
