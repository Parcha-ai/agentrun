// A recovered script's output (scripts.ts execRecovery, waitResumed; code-mode.ts recoverItems) after a crash is one tool
// result the model reads, so it is held to the same per-model bound as every other result (the kernel's boundResult at
// the model's window, resultMaxChars): a 16k model is never handed the host's 120k-plus because a crash cut its script
// short. With no window it is the bound it always was (EXEC_RECOVERY_MAX_CHARS). Pure, then through code mode on a log:
// no Codex binary, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { openTurn, placeSubmissions, toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codeMode, NESTED_STREAM } from '../dist/code-mode.js';
import { EXEC_RECOVERY_MAX_CHARS, execRecoveryOutput, waitResumedText } from '../dist/scripts.js';

const SMALL = { contextWindow: 16_384 };
/** The per-model bound of a 16,384-token window (the kernel's resultMaxChars): a quarter of it at three characters a token. */
const SMALL_MAX = 12_288;
const BIG = `START-OF-RESULT ${'r'.repeat(50_000)}`;
const nested = (callId, tool, store) => ({ callId, tool, ...(store ? { store } : {}) });
const done = (text) => ({ status: 'completed', text });

test("a cut-off exec's recovered output, a 16k model: its 50k result quoted within the per-model bound, every call still told", () => {
  // MUTATION: a recovery that ignores the budget (EXEC_RECOVERY_MAX_CHARS alone) hands this 50k result whole and fails here.
  const facts = [nested('e1', 'lookup', done(BIG)), nested('e2', 'record', done('recorded')), nested('e3', 'pay', { status: 'started' })];
  const text = execRecoveryOutput(facts, [], SMALL);
  assert.ok(text.length <= SMALL_MAX, `${text.length} characters, past ${SMALL_MAX}`);
  assert.match(text, /^The exec was cut short after these calls/);
  assert.match(text, /1\. lookup completed: "START-OF-RESULT r/, 'the start of the result kept');
  assert.match(text, /2\. record completed: "recorded"/);
  assert.match(text, /3\. pay was started and did not report a result/);
  const whole = execRecoveryOutput(facts, []);
  assert.ok(whole.length > 50_000 && whole.length <= EXEC_RECOVERY_MAX_CHARS, `no window: the bound as it was (${whole.length})`);
});

test("a resumed wait's output, a 16k model: the parked call's 50k answer quoted within the per-model bound", () => {
  const resumed = [{ ...nested('e1', 'lookup'), resumed: { text: BIG, isError: false, ran: true } }];
  const text = waitResumedText('1', resumed, SMALL);
  assert.ok(text.length <= SMALL_MAX, `${text.length} characters, past ${SMALL_MAX}`);
  assert.match(text, /1\. lookup waited for a person's approval, then ran: "START-OF-RESULT r/);
  assert.ok(waitResumedText('1', resumed).length > 50_000, 'no window: whole, within the host bound');
});

test('a window too small for any of it: the recovered output passes none of the result through, and stays short', () => {
  for (const budget of [{ contextWindow: 100 }, { contextWindow: 16_384, baseInputTokens: 16_384 }]) {
    const text = execRecoveryOutput([nested('e1', 'lookup', done(BIG))], [], budget);
    assert.ok(!text.includes('rrrr'), `${JSON.stringify(budget)}: none of the result: ${text.slice(0, 300)}`);
    assert.ok(text.length < 1_000, `${JSON.stringify(budget)}: short (${text.length})`);
    const waitText = waitResumedText('1', [{ ...nested('e1', 'lookup'), resumed: { text: BIG, isError: false, ran: true } }], budget);
    assert.ok(!waitText.includes('rrrr'), `${JSON.stringify(budget)}: the wait's none of it`);
  }
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EXEC = 'call_exec_1';

test("code mode hands a cut-off exec's recovered output to Codex held to the session's window (its budget)", async () => {
  // One exec whose script's call completed with 50k, then the process stopped before the exec answered.
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Look it up.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const since = openTurn(first.state()).since;
  const big = { name: 'lookup', description: 'Looks up.', inputSchema: { type: 'object' }, replay: 'safe', execute: async () => BIG };
  await toolBridge(first, [big], { live: false, serial: false }).call('lookup', {}, 'exec-1');
  await pause(10);
  const next = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  const ties = [{ callId: 'exec-1', exec: EXEC, since }];
  const journal = { append() {}, flush: async () => {}, read: async (stream) => (stream === NESTED_STREAM ? ties.map((data) => ({ data })) : []) };
  const recovered = async (budget) => {
    const mode = codeMode({ ctx: next, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge: { get: () => undefined }, log() {}, lines: [], rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1, ...(budget ? { budget } : {}) });
    const items = [{ type: 'custom_tool_call_output', call_id: EXEC, output: '' }];
    await mode.recoverItems(items, [{ callId: EXEC, name: 'exec', type: 'custom_tool_call' }], [], since);
    return items[0].output;
  };
  const small = await recovered(SMALL);
  assert.ok(small.length <= SMALL_MAX, `${small.length} characters, past ${SMALL_MAX}`);
  assert.match(small, /1\. lookup completed: "START-OF-RESULT r/);
  assert.ok((await recovered()).length > 50_000, 'no budget: the result quoted whole, as before');
});
