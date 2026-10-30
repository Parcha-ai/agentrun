// The Codex adapter behind createHarnessRunner, as a DSL host runs it, on the stand-in app-server (fake-app-server.mjs)
// with its model requests going through the session's real proxy to a scripted provider. No network, no Codex binary.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createHarnessRunner, RUNNER_RECORDS } from '@parcha/agentrun-adapters';
import { foldSession, openDrive } from '@parcha/agentrun-adapters/kernel';
import { NativeJournal, toolBridge, transcriptOf } from '@parcha/agentrun-adapters/process';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { CodexNotInstalled, CodexPinMismatch, codexAdapter } from '@parcha/agentrun-codex';
import { findCodex } from '../dist/binary.js';
import { codeMode, waitStoppedText, withOutputKind } from '../dist/code-mode.js';
import { verifyCodexBinary } from '../dist/verify.js';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
const doc = (root) => ({ v: 2, name: 'codex', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root });
const agent = (extra = {}) => ({ node: 'agent', label: 'task', instructions: 'Answer.', out: 'Out', as: 'final', ...extra });

/** The provider: every request it gets, answered with a short stream that ends with its usage. */
function provider() {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) });
    const events = [{ delta: 'ok' }, { delta: '', type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 3 } } }];
    return new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { seen, fetch };
}

/** A Codex adapter on the stand-in, whose turns follow `script`. */
function adapter(script, extra = {}) {
  const dir = scratch();
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify(script));
  const p = provider();
  const a = codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    price: (_model, usage) => (usage.input + usage.output) / 1e6,
    sessionsDir: join(dir, 'sessions'),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_MODEL: 'remote', FAKE_CODEX_SCRIPT: file } },
    fetch: p.fetch,
    ...extra,
  });
  return { adapter: a, provider: p };
}

test('a DSL agent node runs on Codex: the host tool, then submit, through the proxy to the provider', async () => {
  const calls = [];
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async (args) => { calls.push(args); return { text: 'found' }; } };
  const { adapter: codex, provider: p } = adapter(['call lookup {"q":"x"}', 'call submit {"value":{"answer":"found"}}']);
  const store = memorySessionStore();
  const events = [];
  const runNode = createHarnessRunner(codex, { store, tools: [lookup], onEvent: (e) => events.push(e) });
  const result = await runWorkflow(doc(agent({ tools: ['lookup'] })), {}, { runNode });

  assert.equal(result.status, 'complete', JSON.stringify(result.error ?? null));
  assert.deepEqual(result.output, { answer: 'found' });
  assert.deepEqual(calls, [{ q: 'x' }]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_start').map((e) => e.name), ['lookup', 'submit']);
  // Every request went to the provider's one route, with its key, the session's model, and nothing stored.
  assert.ok(p.seen.length >= 2);
  for (const r of p.seen) {
    assert.equal(r.url, 'https://provider.invalid/v1/responses');
    assert.equal(r.headers.authorization, 'Bearer provider-secret');
    assert.equal(r.body.model, 'luna-test');
    assert.equal(r.body.store, false);
  }
  // Each request was admitted by the runner before it left, and its cost came back.
  const [key] = store.keys();
  const records = await store.read(key);
  assert.equal(records.filter((r) => r.kind === RUNNER_RECORDS.request).length, p.seen.length);
  assert.deepEqual(records.filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data.usd), p.seen.map(() => 15 / 1e6));
});

test("a crash inside a never tool's call: the next process recovers the turn, and the call is reported, never run again", async () => {
  const dir = scratch();
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify(['call charge {"amount":5}']));
  const codex = codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    sessionsDir: join(dir, 'sessions'),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_SCRIPT: file } },
  });
  let charged = 0;
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never', call: (_args, { signal }) => { charged += 1; inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:s1', label: 'pay', system: [], tools: [charge], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };

  // The first process: the call starts, then the process dies (its signal), with no outcome written.
  const first = new AbortController();
  const a = await codex.open(spec, { writer: await store.open(spec.key), models, signal: first.signal, onEvent: () => {} });
  assert.equal(a.state, 'new');
  await a.send('pay');
  await reached;
  first.abort(new Error('the process died'));
  assert.equal((await a.turnEnd()).status, 'interrupted');
  await a.close();

  // The next process: the turn is open; recovering it reports the call interrupted and does not run it again.
  const b = await codex.open(spec, { writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'open_turn');
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  assert.equal(b.state, 'idle');
  await b.close();
  assert.equal(charged, 1, 'the charge ran once');
  const records = await store.read('step:s1');
  const ended = records.filter((r) => r.kind === 'kernel.end').map((r) => r.data);
  assert.ok(ended.some((e) => e.status === 'failed' && e.error?.interrupted === true), JSON.stringify(ended));
});

/** A Codex adapter on the stand-in for a bare session (no provider traffic): its turns follow `script`. */
function bare(script, sessionsDir) {
  const dir = scratch();
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify(script));
  return codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    sessionsDir: sessionsDir ?? join(dir, 'sessions'),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_SCRIPT: file } },
  });
}
const MODELS = { beforeRequest: async () => {}, afterRequest: async () => {} };
const until = async (done, what, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** The calls in the session's Codex rollout that have no output line: what the next turn's history would hold unanswered. */
function unansweredCalls(sessionsDir) {
  const files = readdirSync(sessionsDir, { recursive: true }).filter((f) => /rollout-.*\.jsonl$/.test(String(f)));
  assert.equal(files.length, 1, 'one rollout');
  const items = readFileSync(join(sessionsDir, String(files[0])), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'response_item').map((l) => l.payload);
  const answered = new Set(items.filter((i) => i.type === 'function_call_output').map((i) => i.call_id));
  return items.filter((i) => i.type === 'function_call' && !answered.has(i.call_id)).map((i) => i.call_id);
}

/** A session whose turn a crash cut off inside a never call of `toolName`, with the turn then closed in the log (as a settle does), and a new send. */
async function crashThenClosedThenSend(toolName) {
  const dir = scratch();
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify([`call ${toolName} {"amount":5}`, 'next']));
  const codex = codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    sessionsDir: join(dir, 'sessions'),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_SCRIPT: file } },
  });
  let charged = 0;
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const charge = { name: toolName, description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never', call: (_args, { signal }) => { charged += 1; inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut off')), { once: true })); } };
  const spec = { key: 'step:repair', label: 'pay', system: [], tools: [charge], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };

  const first = new AbortController();
  const a = await codex.open(spec, { writer: await store.open(spec.key), models, signal: first.signal, onEvent: () => {} });
  await a.send('pay');
  await reached;
  first.abort(new Error('the process died'));
  assert.equal((await a.turnEnd()).status, 'interrupted');
  await a.close();
  assert.equal(unansweredCalls(join(dir, 'sessions')).length, 1, 'the crash left the call without an output in the rollout');

  // The turn is closed in the log without resuming it, as a settle does: the next open has no open turn, so no recovery note.
  const closing = await openDrive({ writer: await store.open(spec.key), signal: new AbortController().signal });
  const journal = new NativeJournal(closing);
  journal.message({ type: 'turn', status: 'interrupted' });
  await journal.flush();

  const b = await codex.open(spec, { writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'idle', 'no open turn, so no recovery note');
  await b.send('next');
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();
  return { charged, dir };
}

test("a crash inside a never tool's call, then the turn closed in the log: the next send answers the dangling call from the log before the new turn, and the call is never run again", async () => {
  const { charged, dir } = await crashThenClosedThenSend('charge');
  assert.equal(charged, 1, 'the cut call is never run again');
  assert.deepEqual(unansweredCalls(join(dir, 'sessions')), [], 'every call in the history the new turn sends has its output');
});

test('a host tool named exec is a function call: the repair answers it with the generic output, never as code mode\'s exec', async () => {
  const { charged, dir } = await crashThenClosedThenSend('exec');
  assert.equal(charged, 1);
  assert.deepEqual(unansweredCalls(join(dir, 'sessions')), [], 'its function call has a function_call_output');
});

test("an interrupt while a never tool's outcome is still being written: the next turn's drive folds the outcome, never takes it for abandoned", async () => {
  let charged = 0;
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never', call: async () => { charged += 1; return { text: 'paid' }; } };
  const spec = { key: 'step:reopen', label: 'pay', system: [], tools: [charge], context: 'fresh' };
  const store = memorySessionStore();
  const raw = await store.open(spec.key);
  // The session's writer, with the charge's outcome append held, as a slow store holds it.
  const charges = new Set();
  let release;
  let held = false;
  const writer = { key: raw.key, read: () => raw.read(), append: async (records) => {
    for (const r of records) if (r.kind === 'kernel.start' && r.data.name === 'tool.charge') charges.add(r.data.stepId);
    if (!held && records.some((r) => r.kind === 'kernel.end' && charges.has(r.data.stepId))) { held = true; await new Promise((resolve) => { release = resolve; }); }
    return raw.append(records);
  } };
  const session = await bare(['call charge {"amount":5}', 'hello']).open(spec, { writer, models: MODELS, signal: new AbortController().signal, onEvent: () => {} });
  await session.send('pay');
  await until(() => held, 'the charge outcome in flight');
  // The interrupt halts the drive and the next turn opens a new one on the same writer, while the outcome is still held.
  const next = (async () => { await session.interrupt(); await session.send('and then?'); return session.turnEnd(); })();
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  await next;
  await session.close();
  assert.equal(charged, 1, 'the charge ran once');
  const outcome = [...foldSession(spec.key, await raw.read()).effects.values()].find((e) => e.name === 'tool.charge');
  assert.equal(outcome?.status, 'completed', `the charge ran and paid, but the log says ${outcome?.status}${outcome?.error ? ` (${outcome.error.message.slice(0, 60)})` : ''}`);
});

test('the same call delivered twice runs its tool once, and both deliveries are answered with the one result', async () => {
  for (const replay of ['never', 'safe']) {
    let ran = 0;
    const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay, call: async () => { ran += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { text: 'paid' }; } };
    const spec = { key: `step:twice-${replay}`, label: 'pay', system: [], tools: [charge], context: 'fresh' };
    const store = memorySessionStore();
    const session = await bare(['twice charge {"amount":5}']).open(spec, { writer: await store.open(spec.key), models: MODELS, signal: new AbortController().signal, onEvent: () => {} });
    await session.send('pay');
    assert.equal((await session.turnEnd()).status, 'completed', replay);
    await session.close();
    assert.equal(ran, 1, `a ${replay} tool ran once for one call id`);
    const calls = [...foldSession(spec.key, await store.read(spec.key)).effects.values()].filter((e) => e.name === 'tool.charge');
    assert.deepEqual(calls.map((e) => e.status), ['completed'], replay);
  }
});

test('a fresh box recovers a crashed never call from the session store alone, and does not run it again', async () => {
  let charged = 0;
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never', call: (_args, { signal }) => { charged += 1; inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:fresh-box', label: 'pay', system: [], tools: [charge], context: 'fresh' };
  const store = memorySessionStore();
  const died = new AbortController();
  const a = await bare(['call charge {"amount":5}']).open(spec, { writer: await store.open(spec.key), models: MODELS, signal: died.signal, onEvent: () => {} });
  await a.send('pay');
  await reached;
  died.abort(new Error('the process died'));
  assert.equal((await a.turnEnd()).status, 'interrupted');
  await a.close();
  // Nothing of the first process's directory survives: the store is all the next one has.
  const b = await bare(['hello']).open(spec, { writer: await store.open(spec.key), models: MODELS, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'open_turn');
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();
  assert.equal(charged, 1, 'the charge ran once');
});

test('making the adapter checks the binary against the pins: one that is not the pinned build is a typed error before any turn', async () => {
  const dir = scratch();
  const impostor = join(dir, 'codex');
  writeFileSync(impostor, '#!/bin/sh\necho "codex-cli 0.0.1"\n');
  chmodSync(impostor, 0o755);
  const options = { model: 'luna-test', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions') };
  const before = process.env.CODEX_BIN;
  try {
    process.env.CODEX_BIN = impostor;
    assert.throws(() => codexAdapter(options), (error) => error instanceof CodexPinMismatch && /^(binary_sha256|version)$/.test(error.pin), 'a binary that is not the pinned build');
    process.env.CODEX_BIN = join(dir, 'no-such-codex');
    assert.throws(() => codexAdapter(options), (error) => error instanceof CodexNotInstalled, 'no binary at the path');
  } finally {
    if (before === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = before;
  }
});

test("a never tool's intent is in the log before the tool runs, so a crash in the call is always reported, never repeated", async () => {
  const spec = { key: 'step:intent', label: 'pay', system: [], tools: [], context: 'fresh' };
  const store = memorySessionStore();
  const writer = await store.open(spec.key);
  let logged;
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never', call: async () => {
    // What the session's records hold at the moment the tool starts running.
    logged = (await writer.read()).filter((r) => r.kind === 'kernel.start' && r.data.name === 'tool.charge').length;
    return { text: 'paid' };
  } };
  const session = await bare(['call charge {"amount":5}']).open({ ...spec, tools: [charge] }, { writer, models: MODELS, signal: new AbortController().signal, onEvent: () => {} });
  await session.send('pay');
  assert.equal((await session.turnEnd()).status, 'completed');
  await session.close();
  assert.equal(logged, 1, 'the intent was durable before the tool ran');
});

const pinned = !(verifyCodexBinary(findCodex()) instanceof Error);

test('a session runs exactly the binary that was checked when the adapter was made, whatever CODEX_BIN says by then', { skip: !pinned && 'the pinned Codex binary is not installed here', timeout: 60_000 }, async () => {
  const dir = scratch();
  const marker = join(dir, 'impostor-ran');
  const impostor = join(dir, 'codex');
  writeFileSync(impostor, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  chmodSync(impostor, 0o755);
  const before = process.env.CODEX_BIN;
  delete process.env.CODEX_BIN;
  try {
    const codex = codexAdapter({ model: 'luna-test', provider: { origin: 'http://127.0.0.1:9', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions') });
    // The host changes CODEX_BIN after the adapter was made: the next session must not run what was never checked.
    process.env.CODEX_BIN = impostor;
    const spec = { key: 'step:binary', label: 'x', system: [], tools: [], context: 'fresh' };
    const store = memorySessionStore();
    let ended;
    try {
      const session = await codex.open(spec, { writer: await store.open(spec.key), models: MODELS, signal: AbortSignal.timeout(40_000), onEvent: () => {} });
      await session.send('hello');
      ended = await session.turnEnd().catch((error) => ({ status: 'failed', error: String(error) }));
      await session.close();
    } catch (error) {
      ended = { status: 'failed', error: String(error) };
    }
    assert.ok(ended, 'the turn ended');
    assert.equal(existsSync(marker), false, 'the unchecked binary ran');
  } finally {
    if (before === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = before;
  }
});

test("a model Codex runs in code mode is checked like any other: the check refuses nothing for its model", { skip: !pinned && 'the pinned Codex binary is not installed here', timeout: 60_000 }, () => {
  const dir = scratch();
  const make = (model) => codexAdapter({ model, provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions') });
  const spec = { key: 'step:mode', label: 'x', system: [], tools: [], context: 'fresh' };
  for (const model of ['gpt-5.4-mini', 'gpt-6-sol', 'gpt-5.6-luna']) assert.deepEqual(make(model).check(spec), [], model);
  const tiered = codexAdapter({ model: { default: 'gpt-5.4-mini', strong: 'gpt-6-sol' }, provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions') });
  assert.deepEqual(tiered.check({ ...spec, tier: 'strong' }), []);
});

test('a dangling custom tool call that is not exec, such as apply_patch, is answered with a custom tool call output', () => {
  const call = (type, name) => ({ callId: `c-${name}`, name, type });
  // Codex's own apply_patch is a freeform custom tool: a crash inside it leaves a custom_tool_call, which only a custom output answers.
  const item = withOutputKind({ call_id: 'c-apply_patch', output: 'Not executed: the session stopped before this call started.' }, call('custom_tool_call', 'apply_patch'));
  assert.deepEqual(item, { type: 'custom_tool_call_output', call_id: 'c-apply_patch', output: 'Not executed: the session stopped before this call started.' });
  assert.equal(withOutputKind({ call_id: 'c-shell', output: 'x' }, call('function_call', 'shell')).type, 'function_call_output');
});

/** The no-note repair of a rollout holding `calls`, unanswered, with `hostTools` bridged: the items it injects. `order`, when given, records
 *  the inject, the end of the sync after it (which takes a tick, as draining the rollout's tail does), and the repair's return. */
async function repairedItems(calls, hostTools = [], order, { ctx, ties = [] } = {}) {
  const injected = [];
  const code = codeMode({
    ctx: ctx ?? { state: () => ({ effects: new Map(), submissions: [], effectOrder: [] }), isMemoized: () => false },
    machine: {},
    journal: { append() {}, flush: async () => {}, read: async (stream) => (stream === 'codex.nested' ? ties.map((data) => ({ data })) : []) },
    logged: new Set(),
    synced: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); order?.push('synced'); },
    bridge: { get: (name) => hostTools.find((t) => t === name) && { name, replay: 'safe' } },
    log() {},
    lines: [],
    rpc: () => ({ request: async (method, params) => { order?.push(method); injected.push(...params.items); } }),
    guard: (promise) => promise,
    threadId: () => 'thread-1',
    tries: 1,
    declined: 'declined',
  });
  await code.repairUnnoted(calls.map((payload) => JSON.stringify({ timestamp: '2026-10-30T00:00:00.000Z', type: 'response_item', payload })));
  order?.push('returned');
  return injected;
}

test('the no-note repair answers each dangling call with an output of its own kind: a custom tool call output for apply_patch, a function call output for a function call', async () => {
  const applyPatch = { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch', call_id: 'call_patch' };
  const shell = { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'call_shell' };
  const items = await repairedItems([applyPatch, shell]);
  assert.deepEqual(items.map((item) => [item.call_id, item.type]), [['call_patch', 'custom_tool_call_output'], ['call_shell', 'function_call_output']]);
  for (const item of items) assert.match(item.output, /^Not executed: the session stopped before this call started/, 'the same text for either kind');
});

test("the no-note repair returns only once the rollout's tail is synced after the inject, so the next turn starts on a log that holds the outputs", async () => {
  const order = [];
  await repairedItems([{ type: 'function_call', name: 'shell', arguments: '{}', call_id: 'call_shell' }], [], order);
  assert.deepEqual(order, ['thread/inject_items', 'synced', 'returned']);
});

test("a dangling wait of code mode is told the session stopped while it waited on its cell, never that it did not start", async () => {
  const wait = { type: 'function_call', name: 'wait', arguments: JSON.stringify({ cell_id: '3', yield_time_ms: 5000 }), call_id: 'call_wait' };
  const [item] = await repairedItems([wait]);
  assert.deepEqual(item, { type: 'function_call_output', call_id: 'call_wait', output: waitStoppedText('3') });
  assert.match(item.output, /^The session stopped while waiting on cell 3; that cell's script was cut off, and nothing was run again\./);
  // A host tool of the same name is not code mode's wait: it gets the generic answer.
  const [host] = await repairedItems([wait], ['wait']);
  assert.match(host.output, /^Not executed: the session stopped before this call started/);
});

test("the no-note repair lists the ended turn's calls whose script could not be told under its cut-off exec, and never an earlier turn's", async () => {
  // A session log of two turns: a call in each, and each turn ended (the second as a settle ends it).
  const drive = await openDrive({ writer: await memorySessionStore().open('step:two-turns'), signal: new AbortController().signal });
  const journal = new NativeJournal(drive);
  const tool = (name) => ({ name, description: name, inputSchema: { type: 'object' }, replay: 'safe', execute: async () => `${name} result` });
  const bridge = toolBridge(drive, [tool('early'), tool('late')], { live: false });
  await bridge.call('early', {}, 'n0');
  journal.message({ type: 'turn', status: 'completed' });
  await journal.flush();
  await bridge.call('late', {}, 'n1');
  journal.message({ type: 'turn', status: 'interrupted' });
  await journal.flush();
  const [firstEnd] = transcriptOf(drive.state()).filter((r) => r.data?.type === 'turn').map((r) => r.at);
  // Both calls ran under answers that could not be read to their end, so neither is tied to an exec; each carries its turn's start.
  const ties = [{ callId: 'n0', exec: null, since: -1 }, { callId: 'n1', exec: null, since: firstEnd }];
  const exec = { type: 'custom_tool_call', name: 'exec', input: 'await tools.late({})', call_id: 'call_js' };
  const [item] = await repairedItems([exec], [], undefined, { ctx: drive, ties });
  assert.equal(item.type, 'custom_tool_call_output');
  assert.match(item.output, /1 call ran whose script could not be told/);
  assert.match(item.output, /late completed: "late result"/);
  assert.doesNotMatch(item.output, /early/);
});

test("a Codex turn the session itself stops, by its interrupt or its close, ends interrupted", async () => {
  for (const stop of ['interrupt', 'close']) {
    let inside;
    const reached = new Promise((resolve) => { inside = resolve; });
    const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
    const { adapter: codex } = adapter(['call wait {}']);
    const spec = { key: `step:${stop}`, label: 'w', system: [], tools: [wait], context: 'fresh' };
    const store = memorySessionStore();
    const session = await codex.open(spec, { store, writer: await store.open(spec.key), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: () => {} });
    await session.send('go');
    await reached;
    const ending = session.turnEnd();
    if (stop === 'interrupt') await session.interrupt(); else await session.close();
    assert.equal((await ending).status, 'interrupted', stop);
    if (stop === 'interrupt') await session.close();
  }
});


test("the adapter ends an aborted turn only through the kernel's abortedOutcome, and keeps no interrupted end of its own", () => {
  // Structural: a halt with a reason the fakes cannot raise mid-turn still ends this adapter's turn as every other's.
  const source = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
  assert.match(source, /abortedOutcome\(current\.signal, io\.signal\)/);
  assert.doesNotMatch(source, /status:\s*"interrupted"/);
});
