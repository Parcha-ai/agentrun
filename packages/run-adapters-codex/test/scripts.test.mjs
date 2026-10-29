// Which code-mode script a nested host-tool call belongs to: read from the rollout's lines and from the exec the model proxy's
// latest answer carried. Pure: no binary, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NESTED_CALL, Scripts } from '../dist/scripts.js';

const line = (payload) => JSON.stringify({ timestamp: '2026-10-29T23:00:00Z', type: 'response_item', payload });
const exec = (callId) => line({ type: 'custom_tool_call', name: 'exec', call_id: callId, input: 'await tools.slow({})' });
const execDone = (callId, text = 'Script completed\nWall time 0.1 seconds\nOutput:\n') => line({ type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text }] });
const execYielded = (callId, cell = '1') => line({ type: 'custom_tool_call_output', call_id: callId, output: `Script running with cell ID ${cell}\nWall time 0.1 seconds\nOutput:\n` });
const wait = (callId, cell = '1') => line({ type: 'function_call', name: 'wait', call_id: callId, arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 5000 }) });
const waited = (callId, text) => line({ type: 'function_call_output', call_id: callId, output: [{ type: 'input_text', text }] });
/** A Scripts that has read `lines`, and which call ids are in the log. */
function read(...lines) {
  const scripts = new Scripts();
  const logged = new Set();
  for (const l of lines) {
    scripts.note(l);
    const p = JSON.parse(l).payload;
    if (/_call$/.test(p.type)) logged.add(p.call_id);
  }
  return { scripts, logged, tie: (announced) => scripts.tie(announced, (id) => logged.has(id)) };
}

test("a nested call's id is the one Codex gives a script's host tool call, and a model's call id is not", () => {
  assert.ok(NESTED_CALL.test('exec-0e41febd-a273-40e5-8b2a-44fb79a552ae'));
  for (const id of ['call_ZbDRvcBcuhSOo7QpT3R8LDV7', 'exec-1', 'exec-0e41febd-a273-40e5-8b2a-44fb79a552ae-x', '']) assert.ok(!NESTED_CALL.test(id), id);
});

test("with one exec in the log, a nested call is tied to it; with none known, it waits for one", () => {
  assert.deepEqual(read().tie(undefined), { kind: 'none' });
  assert.deepEqual(read(exec('call_a')).tie(undefined), { kind: 'tied', exec: 'call_a' });
  // The proxy has seen the exec before its line is in the log: the call waits for the line, and is then tied.
  assert.deepEqual(read().tie('call_a'), { kind: 'held', exec: 'call_a' });
  const { scripts, logged } = read();
  assert.deepEqual(scripts.tie('call_a', (id) => logged.has(id)), { kind: 'held', exec: 'call_a' });
  scripts.note(exec('call_a'));
  logged.add('call_a');
  assert.deepEqual(scripts.tie('call_a', (id) => logged.has(id)), { kind: 'tied', exec: 'call_a' });
});

test("a finished exec is not live: the next exec's nested call is held until that exec's own line is in the log", () => {
  // exec A ran and has its output; the model wrote exec B, which the proxy saw, but B's line is not in the log yet.
  const { scripts, logged } = read(exec('call_a'), execDone('call_a'));
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'held', exec: 'call_b' }, 'not tied to A');
  scripts.note(exec('call_b'));
  logged.add('call_b');
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'tied', exec: 'call_b' });
  // And with the answer's announcement gone (the latest answer held no exec) and B finished, nothing is live.
  scripts.note(execDone('call_b'));
  assert.deepEqual(scripts.tie(undefined, (id) => logged.has(id)), { kind: 'none' });
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'none' }, 'an exec that finished is not live again when it is still the latest announced');
});

test("a script that yielded stays live until the wait that finishes its cell; its nested call after the wait is tied to it", () => {
  const yielded = read(exec('call_a'), execYielded('call_a'));
  assert.deepEqual(yielded.tie(undefined), { kind: 'tied', exec: 'call_a' }, 'running after its exec had an output');
  const resumed = read(exec('call_a'), execYielded('call_a'), wait('call_w'));
  assert.deepEqual(resumed.tie(undefined), { kind: 'tied', exec: 'call_a' });
  const stillRunning = read(exec('call_a'), execYielded('call_a'), wait('call_w'), waited('call_w', 'Script running with cell ID 1\nWall time 5 seconds'));
  assert.deepEqual(stillRunning.tie(undefined), { kind: 'tied', exec: 'call_a' }, 'a wait that says it still runs does not end it');
  const ended = read(exec('call_a'), execYielded('call_a'), wait('call_w'), waited('call_w', 'Script completed\nWall time 1.8 seconds\nOutput:\n'));
  assert.deepEqual(ended.tie(undefined), { kind: 'none' });
  const gone = read(exec('call_a'), execYielded('call_a'), wait('call_w'), waited('call_w', 'Script failed\nScript error:\nexec cell 1 not found'));
  assert.deepEqual(gone.tie(undefined), { kind: 'none' });
  // A wait on another cell does not end this one.
  const other = read(exec('call_a'), execYielded('call_a', '1'), wait('call_w', '2'), waited('call_w', 'Script completed'));
  assert.deepEqual(other.tie(undefined), { kind: 'tied', exec: 'call_a' });
});

test("two scripts live at once (a cell still running, and a new exec the model wrote): a nested call is ambiguous until one finishes", () => {
  const { scripts, logged } = read(exec('call_a'), execYielded('call_a'));
  // The model wrote exec B anyway; the proxy saw it, and its line is not in the log yet.
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'ambiguous', live: ['call_a', 'call_b'] });
  // Its line lands: still two.
  scripts.note(exec('call_b'));
  logged.add('call_b');
  assert.equal(scripts.tie('call_b', (id) => logged.has(id)).kind, 'ambiguous');
  // A finishes (the wait says so): B alone.
  scripts.note(wait('call_w'));
  scripts.note(waited('call_w', 'Script completed\nWall time 1.8 seconds'));
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'tied', exec: 'call_b' });
});
