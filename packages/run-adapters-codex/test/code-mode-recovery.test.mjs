// A cut-off `exec`'s output after a crash (code-mode.ts recoverItems, scripts.ts execRecoveryOutput): each nested host tool's
// call is told as the recovery note of the same turn tells it, by the replay policy the log recorded when it started. No Codex
// binary: the log, the ties of the nested calls to their exec, and the hook that builds the output.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { bridgeTool, openTurn, placeSubmissions, recoveryNote, toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexToolName } from '../dist/adapter.js';
import { codeMode, NESTED_STREAM } from '../dist/code-mode.js';
import { markParked } from '../dist/scripts.js';

/** A host tool as the adapter bridges it, with the hooks these tests read: by Codex's name for it, a parked call marked. */
const codexTool = (host) => bridgeTool(host, { name: codexToolName(host.name), parked: markParked });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hang = () => new Promise(() => {});
/** A host tool as the adapter hands it to the kernel: a name, a schema and its replay policy. */
const tool = (name, replay) => ({ name, description: name, inputSchema: { type: 'object' }, replay, execute: hang });
const EXEC = 'call_exec_1';

/** One exec whose script called a safe host tool (exec-1) and a never one (exec-2), each cut off mid-call, as the next drive reads it. */
async function cutOffExec() {
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Look it up, then pay.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const since = openTurn(first.state()).since;
  const bridge = toolBridge(first, [tool('read_page', 'safe'), tool('pay', 'never')], { live: false, serial: false });
  void bridge.call('read_page', {}, 'exec-1').catch(() => {});
  await pause(30);
  void bridge.call('pay', {}, 'exec-2').catch(() => {});
  await pause(30);
  // The process stops here; the next drive opens the same log.
  const next = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  const ties = [{ callId: 'exec-1', exec: EXEC, since }, { callId: 'exec-2', exec: EXEC, since }];
  const journal = { append() {}, flush: async () => {}, read: async (stream) => (stream === NESTED_STREAM ? ties.map((data) => ({ data })) : []) };
  const mode = codeMode({ ctx: next, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge: { get: () => undefined }, log() {}, lines: [], rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
  const items = [{ type: 'custom_tool_call_output', call_id: EXEC, output: '' }];
  await mode.recoverItems(items, [{ callId: EXEC, name: 'exec', type: 'custom_tool_call' }], [], since);
  return { state: next.state(), output: items[0].output };
}

test("a cut-off exec tells a safe host tool's call it is safe to repeat, and a never one's that it may have taken effect", async () => {
  const { state, output } = await cutOffExec();
  assert.deepEqual([state.effects.get('tool:exec-1')?.replay, state.effects.get('tool:exec-2')?.replay], ['safe', 'never'], "the log recorded each tool's policy when its call started");
  assert.match(output, /^The exec was cut short after these calls/);
  assert.match(output, /\n1\. read_page was started and did not report a result\. It is safe to repeat\. It was not run again\./);
  assert.match(output, /\n2\. pay was started and did not report a result, so it may have taken effect: check before calling it again\. It was not run again\./);
});

test("a cut-off exec's output says of each nested call what the recovery note of the same turn says of it, never the opposite", async () => {
  // Both reach the model on the same resume: the note as the turn's developer message, the output as the exec's.
  const { state, output } = await cutOffExec();
  const told = Object.fromEntries(recoveryNote(state).calls.map((c) => [c.callId, c.status]));
  assert.deepEqual(told, { 'exec-1': 'retryable', 'exec-2': 'interrupted' });
  const line = (n) => output.split('\n').find((l) => l.startsWith(`${n}. `));
  assert.match(line(1), /It is safe to repeat/);
  assert.doesNotMatch(line(2), /safe to repeat/);
});

/** An exec whose script made one call the host parked for a person's approval, through `call(drive)`, then was cut by the
 *  park (the host ends the turn on it), as the next drive reads it: the exec's recovered output. */
async function parkedExec(call, lines = []) {
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Add them.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const since = openTurn(first.state()).since;
  await call(first);
  const next = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  const ties = [{ callId: 'exec-1', exec: EXEC, since }];
  const journal = { append() {}, flush: async () => {}, read: async (stream) => (stream === NESTED_STREAM ? ties.map((data) => ({ data })) : []) };
  const mode = codeMode({ ctx: next, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge: { get: () => undefined }, log() {}, lines, rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
  const items = [{ type: 'custom_tool_call_output', call_id: EXEC, output: '' }];
  await mode.recoverItems(items, [{ callId: EXEC, name: 'exec', type: 'custom_tool_call' }], [], since);
  return items[0].output;
}

test("a completed computer tool's call, which the rollout holds as the value's JSON (what a script was sent), is completed after a restart, never interrupted, so it is not run again", async () => {
  const { scriptAnswer } = await import('../dist/code-mode.js');
  const value = { steps: [{ route: 'semantic', verified: true }], state: 's2' };
  const host = { name: 'computer_act', description: 'computer_act', inputSchema: { type: 'object' }, replay: 'never', call: async () => ({ text: '1. press: semantic, verified', structured: value }) };
  const sent = scriptAnswer({ contentItems: [{ type: 'inputText', text: '1. press: semantic, verified' }], success: true }, { structured: value });
  const lines = [JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'DynamicToolCall', id: 'exec-1', tool: 'computer_act', status: 'completed', success: true, content_items: sent.contentItems } } })];
  const output = await parkedExec(async (drive) => {
    const bridge = toolBridge(drive, [codexTool(host)], { live: false });
    assert.equal((await bridge.call('computer_act', { steps: [{ press: '@e3' }] }, 'exec-1')).isError, false);
  }, lines);
  assert.match(output, /\n1\. computer_act completed: /);
  assert.match(output, /Its effect is done; it was not run again\./);
  assert.doesNotMatch(output, /may have taken effect/);
});

test("a resumed script that repeats a completed computer call gets the JSON the first call got, with no prose before it", async () => {
  const { scriptAnswer } = await import('../dist/code-mode.js');
  const value = { steps: [{ route: 'semantic', verified: true }], state: 's2' };
  const args = { steps: [{ press: '@e3' }] };
  const host = { name: 'computer_act', description: 'computer_act', inputSchema: { type: 'object' }, replay: 'never', call: async () => ({ text: '1. press: semantic, verified', structured: value }) };
  const sent = scriptAnswer({ contentItems: [{ type: 'inputText', text: '1. press: semantic, verified' }], success: true }, { structured: value });
  const lines = [JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'DynamicToolCall', id: 'exec-1', tool: 'computer_act', status: 'completed', success: true, content_items: sent.contentItems } } })];
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Press it.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const since = openTurn(first.state()).since;
  await toolBridge(first, [codexTool(host)], { live: false }).call('computer_act', args, 'exec-1');
  const next = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  const ties = [{ callId: 'exec-1', exec: EXEC, since }];
  const journal = { append() {}, flush: async () => {}, read: async (stream) => (stream === NESTED_STREAM ? ties.map((data) => ({ data })) : []) };
  const bridge = { get: (name) => (name === 'computer_act' ? { name, replay: 'never' } : undefined), take: () => undefined };
  const mode = codeMode({ ctx: next, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge, log() {}, lines, rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
  await mode.recoverItems([{ type: 'custom_tool_call_output', call_id: EXEC, output: '' }], [{ callId: EXEC, name: 'exec', type: 'custom_tool_call' }], [], since);
  // The resume of the interrupted turn arms the completed never calls the log holds.
  await mode.resumeTurn({ turn: { since }, pending: [] }, []).catch(() => {});
  let ran = 0;
  const answered = await mode.request(async () => { ran += 1; return {}; })({ method: 'item/tool/call', params: { callId: 'exec-00000000-0000-0000-0000-000000000002', tool: 'computer_act', arguments: args } });
  assert.equal(ran, 0, 'the call is not run again');
  assert.deepEqual(JSON.parse(answered.contentItems[0].text), value, 'a script parses the JSON it got the first time');
});

const WAITING = "This mcp:fake/add call waits for a person's approval; the run pauses here and continues with the result when they answer.";

test("a cut-off exec tells a nested MCP call the host parked that it was waiting for a person's approval and did not run, never that it completed", async () => {
  const output = await parkedExec(async (drive) => {
    // The run's MCP tool, a host tool like any other, by the name Codex is given it (mcp_fake__add).
    const host = { name: 'mcp__fake__add', description: 'Adds.', inputSchema: { type: 'object' }, replay: 'never', call: async () => ({ text: WAITING, parked: true }) };
    const bridge = toolBridge(drive, [codexTool(host)], { live: false });
    assert.equal((await bridge.call('mcp_fake__add', { a: 2, b: 3 }, 'exec-1')).text, WAITING, 'the model is told it waits');
  });
  assert.match(output, /\n1\. mcp_fake__add was waiting for a person's approval and did not run; it was not run again\./);
  assert.doesNotMatch(output, /completed|effect is done/i);
});

test("a cut-off exec tells a nested host tool's call the host parked the same: it was waiting for a person's approval and did not run", async () => {
  const output = await parkedExec(async (drive) => {
    const host = { name: 'web_fetch', description: 'web_fetch', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: WAITING.replace('mcp:fake/add', 'web_fetch'), parked: true }) };
    const bridge = toolBridge(drive, [codexTool(host)], { live: false });
    assert.equal((await bridge.call('web_fetch', { url: 'https://example.com' }, 'exec-1')).isError, false);
  });
  assert.match(output, /\n1\. web_fetch was waiting for a person's approval and did not run; it was not run again\./);
  assert.doesNotMatch(output, /completed|effect is done/i);
});

/** An exec whose script's nested MCP call the host's gate parked (a person's approval: the call never reached its intent),
 *  cut when the run parked, then resumed by the next drive under `gate`: the exec's recovered output, and what ran. */
async function gateParkedExec(gate, repair = 'note') {
  const ran = [];
  const host = { name: 'mcp__fake__add', description: 'Adds.', inputSchema: { type: 'object' }, replay: 'never', call: async (args) => (ran.push(args), { text: String(args.a + args.b) }) };
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Add them.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const since = openTurn(first.state()).since;
  const parked = new AbortController();
  const held = toolBridge(first, [codexTool(host)], { live: false, gate: async () => ({ ask: true }) }).call('mcp_fake__add', { a: 2, b: 3 }, 'exec-1', parked.signal);
  await pause(20);
  parked.abort();
  await assert.rejects(held, /was parked/);
  // The tie the request handler wrote as the call came, with the call's tool (Codex's name for it) and arguments.
  const ties = [{ callId: 'exec-1', exec: EXEC, since, tool: 'mcp_fake__add', args: { a: 2, b: 3 } }];
  const next = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  // What the session's journal keeps beside the ties (appended, as the harness's does), read back by a later recovery.
  const kept = [];
  const journal = { append: (stream, data) => kept.push([stream, data]), flush: async () => {}, read: async (stream) => [...(stream === NESTED_STREAM ? ties : []), ...kept.filter(([s]) => s === stream).map(([, data]) => data)].map((data) => ({ data })) };
  const asked = [];
  const bridge = toolBridge(next, [codexTool(host)], { live: false, gate: async (call) => (asked.push(call.callId), gate(call)) });
  const injected = [];
  const mode = codeMode({ ctx: next, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge, log() {}, lines: [], rpc: () => ({ request: async (_method, params) => { injected.push(...params.items); } }), guard: (p) => p, threadId: () => 't', tries: 1 });
  if (repair === 'ended') {
    // No recovery note: the turn was ended (settled), and its rollout still holds the exec unanswered.
    const line = JSON.stringify({ timestamp: '2026-10-30T00:00:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'tools.mcp_fake__add({a:2,b:3})', call_id: EXEC } });
    const recovered = mode.repairUnnoted([line]);
    return { ran, asked, recovered, items: injected, state: () => next.state() };
  }
  if (repair === 'yielded') {
    // The exec had yielded (its "Script running" output is in the rollout): what dangles is the model's `wait` on its cell.
    const wait = { callId: 'call_wait_1', name: 'wait', type: 'function_call', arguments: JSON.stringify({ cell_id: '1' }) };
    const items = [{ type: 'function_call_output', call_id: wait.callId, output: '' }];
    const recovered = mode.recoverItems(items, [wait], [], since, true);
    // The process stops before the wait's output reaches Codex: the next drive recovers the same turn again.
    const again = async () => {
      const later = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
      const laterBridge = toolBridge(later, [codexTool(host)], { live: false, gate: async (call) => (asked.push(call.callId), gate(call)) });
      const laterMode = codeMode({ ctx: later, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge: laterBridge, log() {}, lines: [], rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
      const laterItems = [{ type: 'function_call_output', call_id: wait.callId, output: '' }];
      await laterMode.recoverItems(laterItems, [wait], [], since, true);
      return laterItems;
    };
    return { ran, asked, recovered, items, again, state: () => next.state() };
  }
  const items = [{ type: 'custom_tool_call_output', call_id: EXEC, output: '' }];
  const recovered = mode.recoverItems(items, [{ callId: EXEC, name: 'exec', type: 'custom_tool_call' }], [], since, true);
  /** A second crash, after the recovered output reached the rollout and before the exec's end reached the host's record: the
   *  next drive restores those lines, and the end it records for the exec (`full`: with the output its row shows). */
  const restart = async (full = false) => {
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-30T00:00:00.000Z', type: 'response_item', payload });
    const lines = [line({ type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp_fake__add({a:2,b:3})', call_id: EXEC }), line({ type: 'custom_tool_call_output', call_id: EXEC, output: items[0].output })];
    const later = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
    const ends = [];
    const ownCalls = { opened: async () => {}, nestedIn() {}, ended: async (exec, output, failed) => void ends.push({ exec, failed, ...(full ? { output } : {}) }) };
    codeMode({ ctx: later, machine: {}, ownCalls, journal, logged: new Set(), synced: async () => {}, bridge: { get: () => undefined }, log() {}, lines, rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
    await pause(10);
    return ends;
  };
  return { ran, asked, recovered, items, restart, state: () => next.state() };
}

test("a nested MCP call the gate parked runs once on the resume after the person's allow, under its own id, and the cut-off exec's output carries its result", async () => {
  const { ran, asked, recovered, items } = await gateParkedExec(async () => 'allow');
  await recovered;
  assert.deepEqual(asked, ['exec-1'], "the gate is asked about the call under its own id (the person's answer is on it)");
  assert.deepEqual(ran, [{ a: 2, b: 3 }], 'it ran once');
  assert.match(items[0].output, /\n1\. mcp_fake__add waited for a person's approval, then ran: "5"\. Its effect is done; it was not run again\./);
  assert.doesNotMatch(items[0].output, /may have taken effect|did not report a result/);
  assert.doesNotMatch(items[0].output, /declined/, 'an allowed call is no refusal');
});

test("a nested call the gate parked and the person denied is never run: the exec's output carries the refusal", async () => {
  const { ran, recovered, items } = await gateParkedExec(async () => ({ deny: 'Denied: not now.' }));
  await recovered;
  assert.deepEqual(ran, [], 'never run');
  assert.match(items[0].output, /\n1\. mcp_fake__add waited for a person's approval, then: "Denied: not now\."\. It did not run\./);
  // Told as the person's answer, never as a crash: a model told its script was cut short retried the declined call.
  assert.match(items[0].output, /^The exec stopped at a call that waited for a person's approval/);
  assert.doesNotMatch(items[0].output, /cut short|session stopped/);
  assert.match(items[0].output, /A call a person declined is their answer, not a failure: don't make it again\./);
});

test("a nested call the gate parked after its exec yielded runs once on the person's allow, and the model's pending wait on the cell carries its result", async () => {
  const { ran, asked, recovered, items } = await gateParkedExec(async () => 'allow', 'yielded');
  await recovered;
  assert.deepEqual(asked, ['exec-1'], 'asked about under its own id');
  assert.deepEqual(ran, [{ a: 2, b: 3 }], 'it ran once');
  assert.equal(items[0].type, 'function_call_output');
  assert.match(items[0].output, /^The session stopped while waiting on cell 1; that cell's script was cut off\./);
  assert.match(items[0].output, /\n1\. mcp_fake__add waited for a person's approval, then ran: "5"\. Its effect is done; it was not run again\./);
});

test("a nested call the gate parked after its exec yielded and the person denied is never run: the wait's output carries the refusal", async () => {
  const { ran, items, recovered } = await gateParkedExec(async () => ({ deny: 'Denied: not now.' }), 'yielded');
  await recovered;
  assert.deepEqual(ran, []);
  assert.match(items[0].output, /\n1\. mcp_fake__add waited for a person's approval, then: "Denied: not now\."\. It did not run\./);
  assert.match(items[0].output, /A call a person declined is their answer, not a failure: don't make it again\./);
});

test("a cut-off exec whose recovered output tells a refused call still ends failed when a second crash kept its end off the host's record", async () => {
  const { recovered, items, restart } = await gateParkedExec(async () => ({ deny: 'Denied: not now.' }));
  await recovered;
  assert.match(items[0].output, /It did not run\./);
  assert.doesNotMatch(items[0].output, /^Script failed/, 'the recovered output carries no failed header to read it by');
  assert.deepEqual(await restart(), [{ exec: EXEC, failed: true }]);
});

test("a cut-off exec whose recovered output tells an allowed call that ran still ends ok when a second crash kept its end off the host's record", async () => {
  const { recovered, restart } = await gateParkedExec(async () => 'allow');
  await recovered;
  assert.deepEqual(await restart(), [{ exec: EXEC, failed: false }]);
});

/** The end the host's record gets for a yielded exec whose pending wait a resume answered: its rollout lines (the exec, its
 *  "Script running" output, the wait, and the wait's recovered output) read live, as Codex writes them. */
async function yieldedExecEnd(gate, resume = true) {
  const ran = [];
  const host = { name: 'mcp__fake__add', description: 'Adds.', inputSchema: { type: 'object' }, replay: 'never', call: async (args) => (ran.push(args), { text: String(args.a + args.b) }) };
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Add them.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const since = openTurn(first.state()).since;
  const parked = new AbortController();
  const held = toolBridge(first, [codexTool(host)], { live: false, gate: async () => ({ ask: true }) }).call('mcp_fake__add', { a: 2, b: 3 }, 'exec-1', parked.signal);
  await pause(20);
  parked.abort();
  await assert.rejects(held, /was parked/);
  const ties = [{ callId: 'exec-1', exec: EXEC, since, tool: 'mcp_fake__add', args: { a: 2, b: 3 } }];
  const next = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  const kept = [];
  const journal = { append: (stream, data) => kept.push([stream, data]), flush: async () => {}, read: async (stream) => [...(stream === NESTED_STREAM ? ties : []), ...kept.filter(([s]) => s === stream).map(([, data]) => data)].map((data) => ({ data })) };
  const bridge = toolBridge(next, [codexTool(host)], { live: false, gate });
  let listen;
  const ends = [];
  const shown = [];
  const ownCalls = { opened: async () => {}, nestedIn() {}, ended: async (exec, output, failed) => void (ends.push({ exec, failed }), shown.push(output)) };
  const mode = codeMode({ ctx: next, machine: { onRolloutLine: (fn) => (listen = fn) }, ownCalls, journal, logged: new Set(), synced: async () => {}, bridge, log() {}, lines: [], rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
  const wait = { callId: 'call_wait_1', name: 'wait', type: 'function_call', arguments: JSON.stringify({ cell_id: '1' }) };
  const line = (payload) => JSON.stringify({ timestamp: '2026-10-30T00:00:00.000Z', type: 'response_item', payload });
  const before = [
    line({ type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp_fake__add({a:2,b:3})', call_id: EXEC }),
    line({ type: 'custom_tool_call_output', call_id: EXEC, output: 'Script running with cell ID 1' }),
    line({ type: 'function_call', name: 'wait', arguments: wait.arguments, call_id: wait.callId }),
  ];
  for (const l of before) listen(l);
  const items = [{ type: 'function_call_output', call_id: wait.callId, output: '' }];
  await mode.recoverItems(items, [wait], before, since, resume);
  listen(line({ type: 'function_call_output', call_id: wait.callId, output: items[0].output }));
  await pause(10);
  return { ran, ends, shown, output: items[0].output };
}

test("a yielded exec whose pending wait a resume answered with its parked call refused ends failed on the host's record", async () => {
  const { ran, ends, output } = await yieldedExecEnd(async () => ({ deny: 'Denied: not now.' }));
  assert.deepEqual(ran, []);
  assert.match(output, /then: "Denied: not now\."\. It did not run\./);
  assert.deepEqual(ends, [{ exec: EXEC, failed: true }], 'its last call was refused: the script did not finish its work');
});

test("a yielded exec whose pending wait a resume answered with its parked call allowed and run ends ok on the host's record", async () => {
  const { ran, ends } = await yieldedExecEnd(async () => 'allow');
  assert.deepEqual(ran, [{ a: 2, b: 3 }]);
  assert.deepEqual(ends, [{ exec: EXEC, failed: false }], 'parked then allowed is not a failure');
});

// The words that open a recovered output ("cut short", "cut off") tell the model its script went with the session. On the
// host's record they belong to an exec that failed: an exec that ends ok shows its calls' outcomes alone (live, 01a1e117-20b1).
test("an exec that ends ok after its parked call was allowed and ran shows its calls' outcomes on the host's record, never opening with the cut-short words", async () => {
  const { recovered, items, restart } = await gateParkedExec(async () => 'allow');
  await recovered;
  assert.match(items[0].output, /^The exec stopped at a call that waited for a person's approval, and its script did not go on after their answer/, 'the model is still told its script did not go on');
  const [end] = await restart(true);
  assert.equal(end.failed, false);
  assert.doesNotMatch(end.output, /cut short|session stopped/, `an ok exec's row: ${end.output}`);
  assert.match(end.output, /^1\. mcp_fake__add waited for a person's approval, then ran: "5"\. Its effect is done; it was not run again\.$/);
});

test("an exec that ends failed after its parked call was refused keeps the cut-short words on the host's record", async () => {
  const { recovered, items, restart } = await gateParkedExec(async () => ({ deny: 'Denied: not now.' }));
  await recovered;
  const [end] = await restart(true);
  assert.equal(end.failed, true);
  assert.equal(end.output, items[0].output, 'a failed exec shows what the model was told, whole');
});

test("a yielded exec that ends ok after its parked call was allowed and ran shows its calls' outcomes on the host's record, never opening with the cut-off words", async () => {
  const { ends, shown, output } = await yieldedExecEnd(async () => 'allow');
  assert.deepEqual(ends, [{ exec: EXEC, failed: false }]);
  assert.match(output, /^The session stopped while waiting on cell 1; that cell's script was cut off\./, "the model's wait is still told");
  assert.doesNotMatch(shown[0], /cut off|session stopped/, `an ok exec's row: ${shown[0]}`);
  assert.match(shown[0], /^1\. mcp_fake__add waited for a person's approval, then ran: "5"\. Its effect is done; it was not run again\./);
});

test("a yielded exec whose pending wait is told its script was cut off, its parked call never run, ends failed on the host's record", async () => {
  const { ran, ends, output } = await yieldedExecEnd(async () => 'allow', false);
  assert.deepEqual(ran, [], 'an ended turn runs nothing');
  assert.match(output, /^The session stopped while waiting on cell 1; that cell's script was cut off, and nothing was run again\./);
  assert.deepEqual(ends, [{ exec: EXEC, failed: true }]);
});

test("a yielded exec's parked call that ran on an earlier recovery cut before its wait was answered is told again from its record, never run again", async () => {
  const { ran, asked, recovered, again } = await gateParkedExec(async () => 'allow', 'yielded');
  await recovered;
  const items = await again();
  assert.deepEqual(ran, [{ a: 2, b: 3 }], 'it ran once, on the first recovery');
  assert.deepEqual(asked, ['exec-1'], 'not asked again');
  assert.match(items[0].output, /\n1\. mcp_fake__add waited for a person's approval, then ran: "5"\. Its effect is done; it was not run again\./);
});

/** Two crashes around one exec: a crash cuts the exec while its nested call waits on the gate (never reaching its intent), the
 *  resume's gate refuses that call, and a second crash comes before the exec's end reaches the host's record, at `at`:
 *  'flushed' (the recovery's records are in the journal, its output never reached the rollout, so the next drive recovers the
 *  turn again) or 'rolled' (the output is in the rollout, so the next drive restores it). The ends the last drive records. */
async function twoCrashes(at) {
  const ran = [];
  const host = { name: 'mcp__fake__add', description: 'Adds.', inputSchema: { type: 'object' }, replay: 'never', call: async (args) => (ran.push(args), { text: String(args.a + args.b) }) };
  const deny = async () => ({ deny: 'Denied: not now.' });
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Add them.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const since = openTurn(first.state()).since;
  // The first crash: the call waits on its gate when the process goes.
  void toolBridge(first, [codexTool(host)], { live: false, gate: hang }).call('mcp_fake__add', { a: 2, b: 3 }, 'exec-1').catch(() => {});
  await pause(20);
  const ties = [{ callId: 'exec-1', exec: EXEC, since, tool: 'mcp_fake__add', args: { a: 2, b: 3 } }];
  const kept = [];
  const journal = { append: (stream, data) => kept.push([stream, data]), flush: async () => {}, read: async (stream) => [...(stream === NESTED_STREAM ? ties : []), ...kept.filter(([s]) => s === stream).map(([, data]) => data)].map((data) => ({ data })) };
  const line = (payload) => JSON.stringify({ timestamp: '2026-10-30T00:00:00.000Z', type: 'response_item', payload });
  const execLine = line({ type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp_fake__add({a:2,b:3})', call_id: EXEC });
  const drive = async (lines) => {
    const ctx = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
    const ends = [];
    let listen;
    const ownCalls = { opened: async () => {}, nestedIn() {}, ended: async (exec, _output, failed) => void ends.push({ exec, failed }) };
    const bridge = toolBridge(ctx, [codexTool(host)], { live: false, gate: deny });
    const mode = codeMode({ ctx, machine: { onRolloutLine: (fn) => (listen = fn) }, ownCalls, journal, logged: new Set(), synced: async () => {}, bridge, log() {}, lines, rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
    return { mode, ends, listen: (l) => listen(l) };
  };
  // The resume: the gate refuses the call, and the recovery records the exec's outcome before its output is injected.
  const resumed = await drive([]);
  const items = [{ type: 'custom_tool_call_output', call_id: EXEC, output: '' }];
  await resumed.mode.recoverItems(items, [{ callId: EXEC, name: 'exec', type: 'custom_tool_call' }], [execLine], since, true);
  // The second crash.
  if (at === 'rolled') {
    const last = await drive([execLine, line({ type: 'custom_tool_call_output', call_id: EXEC, output: items[0].output })]);
    await pause(10);
    return { ran, ends: last.ends, output: items[0].output };
  }
  const last = await drive([execLine]);
  const again = [{ type: 'custom_tool_call_output', call_id: EXEC, output: '' }];
  await last.mode.recoverItems(again, [{ callId: EXEC, name: 'exec', type: 'custom_tool_call' }], [execLine], since, true);
  last.listen(execLine);
  last.listen(line({ type: 'custom_tool_call_output', call_id: EXEC, output: again[0].output }));
  await pause(10);
  return { ran, ends: last.ends, output: again[0].output };
}

test("a crash, a resume whose gate refuses the exec's call, then a second crash after the recovery's record and before its output reached the rollout: the exec still ends failed", async () => {
  const { ran, ends, output } = await twoCrashes('flushed');
  assert.deepEqual(ran, [], 'never run');
  assert.match(output, /^The exec stopped at a call that waited for a person's approval/);
  assert.match(output, /\n1\. mcp_fake__add waited for a person's approval, then: "Denied: not now\."\. It did not run\./);
  assert.deepEqual(ends, [{ exec: EXEC, failed: true }]);
});

test("a crash, a resume whose gate refuses the exec's call, then a second crash after its output reached the rollout and before the exec's end reached the host's record: the exec still ends failed", async () => {
  const { ran, ends } = await twoCrashes('rolled');
  assert.deepEqual(ran, [], 'never run');
  assert.deepEqual(ends, [{ exec: EXEC, failed: true }]);
});

test("a turn ended without a recovery note never runs a nested call its cut-off exec left parked: the repair only tells the exec's output", async () => {
  // repairUnnoted answers the calls an ended (settled) turn left dangling before the next turn is sent: it is read-only, so a
  // call a person may never have answered is not run on a later, unrelated turn.
  const { ran, asked, recovered, items } = await gateParkedExec(async () => 'allow', 'ended');
  await recovered;
  assert.deepEqual(asked, [], 'the gate is never asked');
  assert.deepEqual(ran, [], 'never run');
  assert.deepEqual(items.map((item) => [item.type, item.call_id]), [['custom_tool_call_output', EXEC]], "the exec still gets its output");
  assert.doesNotMatch(items[0].output, /waited for a person's approval/);
});

test("a nested call's tie keeps the call itself (Codex's name for its tool, its arguments), written before it runs, so a resume can ask about it again", async () => {
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  const appended = [];
  const journal = { append: (stream, data) => appended.push([stream, data]), flush: async () => {}, read: async () => [] };
  const bridge = { get: (name) => (name === 'mcp_fake__add' ? { name, replay: 'safe' } : undefined), take: () => undefined };
  const mode = codeMode({ ctx: drive, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge, log() {}, lines: [], rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
  let seen;
  await mode.request(async () => { seen = appended.length; return { contentItems: [], success: true }; })({ method: 'item/tool/call', params: { callId: 'exec-00000000-0000-0000-0000-000000000001', tool: 'mcp_fake__add', arguments: { a: 2, b: 3 } } });
  const ties = appended.filter(([stream]) => stream === NESTED_STREAM).map(([, data]) => data);
  assert.equal(seen, 1, 'written before the call runs');
  assert.deepEqual(ties.map(({ callId, tool, args }) => ({ callId, tool, args })), [{ callId: 'exec-00000000-0000-0000-0000-000000000001', tool: 'mcp_fake__add', args: { a: 2, b: 3 } }]);
});
