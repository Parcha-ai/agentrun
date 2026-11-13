// Codex's transcript rewrite for a resumed run (src/transcript.ts): the session's mirrored rollout (the lines the next Codex
// resumes its thread from) read for the host's calls Codex made and never got an output for, and one such call given its
// outcome, as Codex itself records a call's output: a function_call_output line after the last, nothing before it changed.
// The shared resume decision runs (or refuses) the call through the bridge first; this only writes what the bridge answered.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { danglingCalls, settleCall } from '../dist/transcript.js';

const THREAD = '0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b';
const line = (type, payload, at = 0) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 8, 12, 0, at)).toISOString(), type, payload });
const tool = (name) => ({ type: 'function', name, description: `The ${name} tool.`, inputSchema: { type: 'object', properties: {} } });
const meta = line('session_meta', { id: THREAD, cwd: '/w', cli_version: '0.164.0', model_provider: 'gateway', dynamic_tools: [tool('effect'), tool('read')] });
const user = line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Follow the script.' }] }, 1);
const call = (callId, name, args) => line('response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId }, 2);
const output = (callId, text) => line('response_item', { type: 'function_call_output', call_id: callId, output: text }, 3);
const LINES = Object.freeze([meta, user, call('call_1', 'effect', { n: 1 })]);

test("a host tool's call with no output is dangling: its id, the host's tool name and its arguments", () => {
  assert.deepEqual(danglingCalls(LINES), [{ callId: 'call_1', tool: 'effect', args: { n: 1 } }]);
  assert.deepEqual(danglingCalls([...LINES, output('call_1', 'ok')]), [], 'a call with its output is not dangling');
});

test("Codex's own calls never dangle here: code mode's exec, its apply_patch, a tool that is not one of the session's", () => {
  const exec = line('response_item', { type: 'custom_tool_call', name: 'exec', input: 'await tools.effect({})', call_id: 'call_x' }, 2);
  const shell = call('call_s', 'exec_command', { cmd: 'ls' });
  assert.deepEqual(danglingCalls([meta, user, exec, shell]), []);
});

test('no session_meta first, no thread to resume: nothing dangles', () => {
  assert.deepEqual(danglingCalls([user, call('call_1', 'effect', {})]), []);
});

test('settled with its outcome: one function_call_output line after the last, nothing before it changed', () => {
  const now = Date.UTC(2026, 10, 8, 12, 5, 0);
  const settled = settleCall(LINES, 'call_1', { text: 'ran once', isError: false }, now);
  assert.deepEqual(settled.slice(0, 3), [...LINES], 'nothing before is changed');
  assert.equal(settled.length, 4);
  assert.deepEqual(JSON.parse(settled[3]), { timestamp: '2026-11-08T12:05:00.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'ran once' } });
  assert.deepEqual(danglingCalls(settled), [], 'nothing dangles after it');
  assert.equal(LINES.length, 3, 'the lines given are not touched');
});

test("a failed or refused outcome is the call's output in its words (Codex's rollout keeps no failure flag)", () => {
  const settled = settleCall(LINES, 'call_1', { text: 'Permission denied: a person denied effect.', isError: true }, 0);
  assert.equal(JSON.parse(settled[3]).payload.output, 'Permission denied: a person denied effect.');
});

test('a call that is not dangling is refused in words, never rewritten', () => {
  assert.throws(() => settleCall(LINES, 'call_9', { text: 'x', isError: false }), /Codex's rollout has no call call_9 of the host's that it made and never got an output for/);
  assert.throws(() => settleCall([...LINES, output('call_1', 'ok')], 'call_1', { text: 'x', isError: false }), /no call call_1/);
});
