// The Codex adapter behind createHarnessRunner, as a DSL host runs it, on the stand-in app-server (fake-app-server.mjs)
// with its model requests going through the session's real proxy to a scripted provider. No network, no Codex binary.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createHarnessRunner, RUNNER_RECORDS } from '@parcha/agentrun-adapters';
import { foldSession } from '@parcha/agentrun-adapters/kernel';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { CodexNotInstalled, CodexPinMismatch, codexAdapter } from '@parcha/agentrun-codex';
import { findCodex } from '../dist/binary.js';
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
