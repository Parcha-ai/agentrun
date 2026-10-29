// A host tool that may run at most once (`replay: 'never'`), called from code mode: the model's `exec` script calls it
// as a nested tool, under Codex's own `exec-*` call id, not the outer call's. The pinned binary, through the adapter, with
// a scripted Responses provider behind the session's proxy. No network.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { codexAdapter } from '@parcha/agentrun-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const required = env.AGENTRUN_CODEX_REQUIRE_BINARY === '1';
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-never-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const MODEL = 'gpt-6-sol';
const MODELS = { beforeRequest: async () => {}, afterRequest: async () => {} };
const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const exec = (callId, js) => ({ type: 'custom_tool_call', name: 'exec', input: js, call_id: callId });
const say = (n) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] });
/** A provider that answers request n with `script[n - 1]` (or a plain reply past its end), keeping what it was sent. */
function provider(script) {
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    return new Response(sse(n, script[n - 1] ?? [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { seen, fetch };
}
const adapter = (fetch, log) => codexAdapter({ model: MODEL, provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: mkdtempSync(join(ROOT, 'box-')), fetch, ...(log ? { log } : {}) });
/** What the model was told about `callId`'s outcome, from the requests it was sent. */
const toldAbout = (seen, callId) => seen.flatMap((body) => body.input ?? []).filter((item) => item.call_id === callId && /_output$/.test(item.type ?? '')).map((item) => (Array.isArray(item.output) ? item.output.map((o) => o.text ?? '').join('\n') : String(item.output)));

test("code mode: an exec that calls a never host tool runs it exactly once", { skip, timeout: 120_000 }, async () => {
  let charged = 0;
  const charge = { name: 'charge', description: 'Charge the card once.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: async () => { charged += 1; return { text: 'charged' }; } };
  const { seen, fetch } = provider([
    [exec('call_charge', `text('charge: ' + JSON.stringify(await tools.charge({ amount: 5 })));`)],
    [exec('call_submit', `text(JSON.stringify(await tools.submit({ value: { answer: 'ok' } })));`)],
  ]);
  const started = [];
  const runNode = createHarnessRunner(adapter(fetch), { store: memorySessionStore(), tools: [charge], timeoutMs: 90_000, onEvent: (e) => { if (e.type === 'tool_start') started.push(e); } });
  const output = await runNode({ kind: 'agent', label: 'pay', system: ['Pay.'], user: 'Charge 5.', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, tools: ['charge'] });
  assert.deepEqual(output, { answer: 'ok' });
  assert.equal(charged, 1, 'the never tool ran once');
  assert.deepEqual(started.map((e) => e.name), ['charge', 'submit']);
  assert.match(started[0].callId, /^exec-/, 'it ran under its nested call id');
  assert.ok(toldAbout(seen, 'call_charge').join('\n').includes('charged'), 'the exec reported its result to the model');
});

test("code mode: a crash after the nested never call completed, before the exec's reply; recovery neither runs it again nor tells the model it did not run", { skip, timeout: 180_000 }, async () => {
  let charged = 0;
  let holding;
  const held = new Promise((resolve) => { holding = resolve; });
  const charge = { name: 'charge', description: 'Charge the card once.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: async () => { charged += 1; return { text: 'charged' }; } };
  // A second nested tool the exec waits in until the process dies: by then the charge has completed and is logged.
  const hold = { name: 'hold', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { holding(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:code-never', label: 'pay', system: [], tools: [charge, hold], context: 'fresh' };
  const store = memorySessionStore();
  const { seen, fetch } = provider([[exec('call_js', `text('charge: ' + JSON.stringify(await tools.charge({ amount: 5 })));\nawait tools.hold({});\ntext('held');`)]]);

  const died = new AbortController();
  const a = await adapter(fetch).open(spec, { writer: await store.open(spec.key), models: MODELS, signal: died.signal, onEvent: () => {} });
  await a.send('pay');
  await held;
  assert.equal(charged, 1, 'the charge completed before the crash');
  died.abort(new Error('the process died'));
  assert.equal((await a.turnEnd()).status, 'interrupted');
  await a.close();
  const before = seen.length;

  // A fresh box: a new sessions directory, the session store all it has.
  const b = await adapter(fetch).open(spec, { writer: await store.open(spec.key), models: MODELS, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'open_turn');
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();

  assert.equal(charged, 1, 'the never tool did not run again');
  const told = toldAbout(seen.slice(before), 'call_js');
  assert.ok(told.length > 0, 'the recovered request reports the exec');
  for (const text of told) assert.ok(!/not executed/i.test(text), `the model is not told the exec did not run: ${JSON.stringify(text)}`);
});

test("code mode: two nested calls of one exec (a Promise.all) each pass the barrier once, under the one exec, and run once", { skip, timeout: 120_000 }, async () => {
  const charged = [];
  const charge = { name: 'charge', description: 'Charge the card once.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: async (args) => { charged.push(args.amount); return { text: `charged ${args.amount}` }; } };
  const { seen, fetch } = provider([
    [exec('call_both', `const both = await Promise.all([tools.charge({ amount: 1 }), tools.charge({ amount: 2 })]); text(JSON.stringify(both));`)],
    [exec('call_submit', `text(JSON.stringify(await tools.submit({ value: { answer: 'ok' } })));`)],
  ]);
  const messages = [];
  const started = [];
  const runNode = createHarnessRunner(adapter(fetch, (message) => messages.push(message)), { store: memorySessionStore(), tools: [charge], timeoutMs: 90_000, onEvent: (e) => { if (e.type === 'tool_start') started.push(e); } });
  const output = await runNode({ kind: 'agent', label: 'pay', system: ['Pay.'], user: 'Charge 1 and 2.', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, tools: ['charge'] });
  assert.deepEqual(output, { answer: 'ok' });
  assert.deepEqual(charged.sort(), [1, 2], 'each ran once');
  const nested = started.filter((e) => e.name === 'charge');
  assert.equal(nested.length, 2);
  assert.equal(new Set(nested.map((e) => e.callId)).size, 2, 'under two nested ids');
  for (const e of nested) assert.match(e.callId, /^exec-/);
  assert.deepEqual(messages.filter((m) => /declined a call/.test(m)), [], 'neither was declined by the barrier');
  assert.ok(toldAbout(seen, 'call_both').join('\n').includes('charged 1'), 'the exec reported both results');
});

test("code mode: a never tool called after its exec yielded runs once, under the cell that is still running", { skip, timeout: 120_000 }, async () => {
  let charged = 0;
  const charge = { name: 'charge', description: 'Charge the card once.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: async () => { charged += 1; return { text: 'charged' }; } };
  // The script yields after 100 ms (its pragma) while this runs, so its exec has an output before the charge is called.
  const slow = { name: 'slow', description: 'Take a while.', inputSchema: { type: 'object', properties: {} }, replay: 'safe', call: async () => { await new Promise((resolve) => setTimeout(resolve, 800)); return { text: 'slept' }; } };
  const wait = (callId, cell) => ({ type: 'function_call', name: 'wait', arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 5000 }), call_id: callId });
  const { seen, fetch } = provider([
    [exec('call_js', `// @exec: {"yield_time_ms": 100}\nawait tools.slow({}); text('charge: ' + JSON.stringify(await tools.charge({ amount: 5 })));`)],
    [wait('call_wait', '1')],
    [exec('call_submit', `text(JSON.stringify(await tools.submit({ value: { answer: 'ok' } })));`)],
  ]);
  const messages = [];
  const started = [];
  const runNode = createHarnessRunner(adapter(fetch, (message) => messages.push(message)), { store: memorySessionStore(), tools: [slow, charge], timeoutMs: 90_000, onEvent: (e) => { if (e.type === 'tool_start') started.push(e); } });
  const output = await runNode({ kind: 'agent', label: 'pay', system: ['Pay.'], user: 'Charge 5.', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, tools: ['slow', 'charge'] });
  assert.deepEqual(output, { answer: 'ok' });
  assert.ok(toldAbout(seen, 'call_js').join('\n').includes('Script running with cell ID 1'), 'the exec yielded: its output came before the charge was called');
  assert.equal(charged, 1, 'the never tool ran once');
  assert.deepEqual(messages.filter((m) => /declined a call/.test(m)), [], 'the barrier did not decline it');
  assert.ok(toldAbout(seen, 'call_wait').join('\n').includes('charged'), 'the wait reported its result to the model');
});

test("code mode: a model that writes a new exec while a cell still runs: a never tool its new script calls is declined, not run", { skip, timeout: 120_000 }, async () => {
  let charged = 0;
  const charge = { name: 'charge', description: 'Charge the card once.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: async () => { charged += 1; return { text: 'charged' }; } };
  const slow = { name: 'slow', description: 'Take a while.', inputSchema: { type: 'object', properties: {} }, replay: 'safe', call: async () => { await new Promise((resolve) => setTimeout(resolve, 6000)); return { text: 'slept' }; } };
  const wait = (callId, cell) => ({ type: 'function_call', name: 'wait', arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 20000 }), call_id: callId });
  // Script A yields and goes on; then the model writes exec B (it was not offered one) and B calls the never tool.
  const { seen, fetch } = provider([
    [exec('call_a', `// @exec: {"yield_time_ms": 100}\nawait tools.slow({}); text('a done');`)],
    [exec('call_b', `text('charge: ' + JSON.stringify(await tools.charge({ amount: 5 })));`)],
    [wait('call_wait', '1')],
    [exec('call_submit', `text(JSON.stringify(await tools.submit({ value: { answer: 'ok' } })));`)],
  ]);
  const messages = [];
  const runNode = createHarnessRunner(adapter(fetch, (message) => messages.push(message)), { store: memorySessionStore(), tools: [slow, charge], timeoutMs: 100_000 });
  const output = await runNode({ kind: 'agent', label: 'pay', system: ['Pay.'], user: 'Charge 5.', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, tools: ['slow', 'charge'] });
  assert.deepEqual(output, { answer: 'ok' });
  assert.ok(toldAbout(seen, 'call_a').join('\n').includes('Script running with cell ID 1'), 'script A yielded and was still running when exec B was written');
  assert.equal(charged, 0, 'the never tool did not run: which script called it could not be told');
  assert.ok(messages.some((m) => /declined a nested call while two scripts are live/.test(m)), 'the barrier declined it for that reason');
  assert.match(toldAbout(seen, 'call_b').join('\n'), /Not run/, 'the model was told it did not run');
});
