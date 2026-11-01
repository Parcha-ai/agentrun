// A cut-off `exec`'s output after a crash (code-mode.ts recoverItems, scripts.ts execRecoveryOutput): each nested host tool's
// call is told as the recovery note of the same turn tells it, by the replay policy the log recorded when it started. No Codex
// binary: the log, the ties of the nested calls to their exec, and the hook that builds the output.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { openTurn, placeSubmissions, recoveryNote, toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codeMode, NESTED_STREAM } from '../dist/code-mode.js';

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
  const bridge = toolBridge(first, [tool('fetch_page', 'safe'), tool('pay', 'never')], { live: false, serial: false });
  void bridge.call('fetch_page', {}, 'exec-1').catch(() => {});
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
  assert.match(output, /\n1\. fetch_page was started and did not report a result\. It is safe to repeat\. It was not run again\./);
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
