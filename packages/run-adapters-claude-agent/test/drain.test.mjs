// Write-ahead on the Claude Agent adapter: the host hears a call ended only once its outcome is in the session's records,
// and a pause (the runner's stop with drainMs) lets a call in flight run on to that record, so the session resumes from
// it: the call never runs again, and its result is never paid for twice.
//
// On the scripted Agent SDK (./testing), behind createHarnessRunner, as a DSL host runs it. No key, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { createHarnessRunner, HarnessRunError } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-claude-agent';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-claude-agent/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-drain-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
const request = { kind: 'agent', label: 'task', system: [], user: 'Search, then answer.', schema: SCHEMA, tools: ['search'], step: { sessionId: 'pause', attempt: 0, earlierSessionIds: [] } };

async function claude(t, { script, sessionsDir }) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  // The system prompt each query sends (the recovery note rides there on a resumed drive).
  const systems = [];
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: (_model, usage) => (usage.input + usage.output) / 1e6,
    sessionsDir,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ remoteModel: true, mirrorLagMs: 10, script, onSystem: (s) => systems.push(s) }),
  });
  return { adapter, provider, systems };
}

/** A paid search: it takes `ms`, and stops (failing) if its signal aborts first, as a request in flight does. */
function paidSearch(ms) {
  const search = { runs: 0, started: undefined };
  let started;
  search.started = new Promise((resolve) => { started = resolve; });
  search.tool = {
    name: 'search', description: 'Search the web (paid per call).', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe',
    call: (args, { signal }) => {
      search.runs += 1;
      started();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ text: `results for ${args.q}` }), ms);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('the search was cut off')); }, { once: true });
      });
    },
  };
  return search;
}

const kernelRecords = async (store) => (await store.read('step:pause')).filter((r) => r.kind.startsWith('kernel.'));
const searchEnd = async (store) => {
  const records = await kernelRecords(store);
  const starts = new Set(records.filter((r) => r.kind === 'kernel.start' && r.data.name === 'tool.search').map((r) => r.data.stepId));
  return records.filter((r) => r.kind === 'kernel.end' && starts.has(r.data.stepId)).map((r) => r.data);
};

test('a pause DURING a paid call: it runs on to its recorded outcome, and the resumed session answers from the record, never running it again', async (t) => {
  const dir = join(scratch(), 'sessions');
  const store = memorySessionStore();
  const search = paidSearch(400);
  const events = [];

  // The first process: the search starts, and the owner pauses with a 15 s drain.
  const first = await claude(t, { script: ['call search {"q":"x"}'], sessionsDir: dir });
  const runner = createHarnessRunner(first.adapter, { store, tools: [search.tool], onEvent: (e) => events.push(e) });
  const node = runner(request).then(() => 'delivered', (error) => error);
  await search.started;
  await runner.stop({ drainMs: 15_000 });
  const stopped = await node;
  assert.ok(stopped instanceof HarnessRunError && stopped.reason === 'aborted', String(stopped));
  assert.equal(search.runs, 1);
  const [end] = await searchEnd(store);
  assert.equal(end?.status, 'completed', `the search ran and was paid for, but the log says ${JSON.stringify(end)}`);
  assert.match(String(end.output?.text ?? end.output), /results for x/);
  assert.ok(events.some((e) => e.type === 'tool_end' && e.name === 'search' && e.isError === false && e.result === 'results for x'), 'the host heard the call end, with its result');

  // The next process: it resumes from the records. The search is never run again, nor retried by the kernel.
  const next = await claude(t, { script: ['call submit {"value":{"answer":"from the record"}}', 'call submit {"value":{"answer":"from the record"}}'], sessionsDir: dir });
  assert.deepEqual(await createHarnessRunner(next.adapter, { store, tools: [search.tool] })(request), { answer: 'from the record' });
  assert.equal(search.runs, 1, 'the search ran once');
  assert.deepEqual((await kernelRecords(store)).filter((r) => r.kind === 'kernel.retry'), [], 'no kernel.retry');
  assert.equal((await searchEnd(store)).length, 1, 'one outcome for the search');
  // The resumed CLI is told the recorded result, in the system prompt its resuming drive sends; no user message carries it.
  assert.match(next.systems[0]?.sent ?? '', /\[Recovery\][\s\S]*- search, call \S+: completed\./, `the CLI was told: ${(next.systems[0]?.sent ?? '').slice(-400)}`);
  assert.ok(!(next.systems[0]?.sent ?? '').includes('results for x'), 'the note names the call and its status, never its output');
  const told = (await store.read('step:pause')).flatMap((r) => r.data?.input?.streams?.claude?.entries ?? [])
    .map((e) => e.data?.message).filter((m) => m?.role === 'user' && typeof m.content === 'string');
  assert.ok(!told.some((m) => /\[Recovery\]/.test(m.content)), `no user message carries the note: ${JSON.stringify(told).slice(0, 400)}`);
});

test("the host hears a call ended only after its outcome is in the session's records", async (t) => {
  const store = memorySessionStore();
  // The search's outcome reaches the store 300 ms after it is handed to it, as a slow store's write does.
  let recorded = false;
  const searchSteps = new Set();
  const slow = Object.create(store);
  slow.open = async (key) => {
    const writer = await store.open(key);
    return { key: writer.key, read: () => writer.read(), append: async (records) => {
      for (const r of records) if (r.kind === 'kernel.start' && r.data.name === 'tool.search') searchSteps.add(r.data.stepId);
      const isOutcome = records.some((r) => r.kind === 'kernel.end' && searchSteps.has(r.data.stepId));
      if (isOutcome) await new Promise((resolve) => setTimeout(resolve, 300));
      await writer.append(records);
      if (isOutcome) recorded = true;
    } };
  };
  const search = paidSearch(10);
  const heard = [];
  const { adapter } = await claude(t, { script: ['call search {"q":"y"}', 'call submit {"value":{"answer":"ok"}}'], sessionsDir: join(scratch(), 'sessions') });
  const runner = createHarnessRunner(adapter, { store: slow, tools: [search.tool], onEvent: (e) => { if (e.type === 'tool_end' && e.name === 'search') heard.push(recorded); } });
  assert.deepEqual(await runner(request), { answer: 'ok' });
  assert.deepEqual(heard, [true], 'one tool_end for the search, sent after its outcome was recorded');
});

test("a call that fails is heard as failed, after its outcome is recorded, with the failure's text", async (t) => {
  const failing = { name: 'search', description: 'Search.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'quota exceeded', isError: true }) };
  const events = [];
  const store = memorySessionStore();
  const { adapter } = await claude(t, { script: ['call search {}', 'call submit {"value":{"answer":"ok"}}'], sessionsDir: join(scratch(), 'sessions') });
  assert.deepEqual(await createHarnessRunner(adapter, { store, tools: [failing], onEvent: (e) => events.push(e) })(request), { answer: 'ok' });
  const ends = events.filter((e) => e.type === 'tool_end' && e.name === 'search');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].isError, true);
  assert.match(ends[0].result, /quota exceeded/);
  assert.equal((await searchEnd(store))[0]?.status, 'failed');
});

test('a session draining sends no new turn: send is refused until the pause is over', async (t) => {
  const search = paidSearch(400);
  const store = memorySessionStore();
  const { adapter } = await claude(t, { script: ['call search {"q":"z"}'], sessionsDir: join(scratch(), 'sessions') });
  const spec = { key: 'step:direct', label: 'task', system: [], tools: [search.tool], context: 'fresh' };
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const session = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  // Closed whatever the assertions find, so a turn this test did not expect never outlives it.
  t.after(async () => { await session.interrupt().catch(() => {}); await session.close(); });
  await session.send('go');
  await search.started;
  const pausing = session.interrupt({ drainMs: 5_000 });
  await assert.rejects(session.send('and another'), /the session is pausing; no new turn/);
  await pausing;
  assert.equal(search.runs, 1);
});

/** A call that never finishes on its own: it stops when its signal aborts, as a hung request does. */
function hanging(name, replay) {
  const tool = { runs: 0 };
  let started;
  tool.started = new Promise((resolve) => { started = resolve; });
  tool.tool = { name, description: 'Wait for an answer that never comes.', inputSchema: { type: 'object' }, replay, call: (_args, { signal }) => {
    tool.runs += 1;
    started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut off by the pause')), { once: true }));
  } };
  return tool;
}

test('a call that outlives the drain is cut at the bound: the pause ends, and the resumed session reports the call interrupted, never dropped', async (t) => {
  const dir = join(scratch(), 'sessions');
  const store = memorySessionStore();
  const charge = hanging('charge', 'never');
  const ask = { ...request, tools: ['charge'], step: { sessionId: 'bound', attempt: 0, earlierSessionIds: [] } };
  const first = await claude(t, { script: ['call charge {}'], sessionsDir: dir });
  const runner = createHarnessRunner(first.adapter, { store, tools: [charge.tool] });
  const node = runner(ask).then(() => 'delivered', (error) => error);
  await charge.started;
  const began = Date.now();
  await runner.stop({ drainMs: 200 });
  const took = Date.now() - began;
  assert.ok(took >= 200 && took < 5_000, `the pause waited the bound, then stopped (${took} ms)`);
  assert.equal((await node).reason, 'aborted');

  const next = await claude(t, { script: ['call submit {"value":{"answer":"after the cut"}}', 'call submit {"value":{"answer":"after the cut"}}'], sessionsDir: dir });
  assert.deepEqual(await createHarnessRunner(next.adapter, { store, tools: [charge.tool] })(ask), { answer: 'after the cut' });
  assert.equal(charge.runs, 1, 'the cut call is never run again');
  const records = await store.read('step:bound');
  const steps = new Set(records.filter((r) => r.kind === 'kernel.start' && r.data.name === 'tool.charge').map((r) => r.data.stepId));
  const ends = records.filter((r) => r.kind === 'kernel.end' && steps.has(r.data.stepId)).map((r) => r.data);
  assert.ok(ends.length === 1 && ends[0].status === 'failed' && ends[0].error?.interrupted === true, `the call is recorded interrupted: ${JSON.stringify(ends)}`);
  assert.match(next.systems[0]?.sent ?? '', /\[Recovery\][\s\S]*- charge, call \S+: interrupted/, `the resumed CLI is told the call was interrupted: ${(next.systems[0]?.sent ?? '').slice(-400)}`);
  const told = records.flatMap((r) => r.data?.input?.streams?.claude?.entries ?? []).map((e) => e.data?.message).filter((m) => m?.role === 'user' && typeof m.content === 'string');
  assert.ok(!told.some((m) => /\[Recovery\]/.test(m.content)), `no user message carries the note: ${JSON.stringify(told).slice(0, 400)}`);
});

test('a call a pause cut off leaves nothing to wait for: the next pause, with nothing in flight, returns at once', async (t) => {
  const wait = hanging('wait', 'safe');
  const store = memorySessionStore();
  const { adapter } = await claude(t, { script: ['call wait {}', 'just say hello'], sessionsDir: join(scratch(), 'sessions') });
  const spec = { key: 'step:twice', label: 'task', system: [], tools: [wait.tool], context: 'fresh' };
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const session = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  t.after(async () => { await session.interrupt().catch(() => {}); await session.close(); });
  await session.send('go');
  await wait.started;
  await session.interrupt({ drainMs: 200 });
  await session.send('again');
  await session.turnEnd();
  const began = Date.now();
  await session.interrupt({ drainMs: 5_000 });
  assert.ok(Date.now() - began < 2_000, `the second pause waited ${Date.now() - began} ms for a call the first one cut`);
});

test("a pause the host starts on submit's tool_start lets that submit deliver: the node returns its answer, never aborted", async (t) => {
  const { adapter } = await claude(t, { script: ['call submit {"value":{"answer":"delivered as the pause began"}}'], sessionsDir: join(scratch(), 'sessions') });
  let paused;
  const runner = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [], onEvent: (e) => { if (e.type === 'tool_start' && e.name === 'submit') paused ??= runner.stop({ drainMs: 10_000 }); } });
  const outcome = await runner({ ...request, tools: [], step: { sessionId: 'pause-on-submit', attempt: 0, earlierSessionIds: [] } }).then((value) => ({ value }), (error) => ({ error }));
  await paused;
  assert.ok(paused, 'the pause was started from tool_start');
  assert.deepEqual(outcome, { value: { answer: 'delivered as the pause began' } }, `delivered, not ${outcome.error?.reason}: ${outcome.error?.message}`);
});

test("a pause the host starts on a tool's tool_start lets that tool run to its recorded outcome", async (t) => {
  const search = paidSearch(200);
  const store = memorySessionStore();
  const { adapter } = await claude(t, { script: ['call search {"q":"w"}'], sessionsDir: join(scratch(), 'sessions') });
  let paused;
  const runner = createHarnessRunner(adapter, { store, tools: [search.tool], onEvent: (e) => { if (e.type === 'tool_start' && e.name === 'search') paused ??= runner.stop({ drainMs: 10_000 }); } });
  const outcome = await runner({ ...request, step: { sessionId: 'pause-on-search', attempt: 0, earlierSessionIds: [] } }).then((value) => ({ value }), (error) => ({ error }));
  await paused;
  assert.equal(outcome.error?.reason, 'aborted', 'the node paused');
  assert.equal(search.runs, 1, 'the search the pause began on ran');
  const records = await store.read('step:pause-on-search');
  const steps = new Set(records.filter((r) => r.kind === 'kernel.start' && r.data.name === 'tool.search').map((r) => r.data.stepId));
  const ends = records.filter((r) => r.kind === 'kernel.end' && steps.has(r.data.stepId)).map((r) => r.data);
  assert.deepEqual(ends.map((e) => e.status), ['completed'], JSON.stringify(ends).slice(0, 300));
});

test("an immediate stop the host starts on a tool's tool_start runs nothing more: the tool never runs and the node ends aborted", async (t) => {
  const search = paidSearch(200);
  const { adapter } = await claude(t, { script: ['call search {"q":"v"}'], sessionsDir: join(scratch(), 'sessions') });
  let stopping;
  const runner = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [search.tool], onEvent: (e) => { if (e.type === 'tool_start' && e.name === 'search') stopping ??= runner.stop(); } });
  const outcome = await runner({ ...request, step: { sessionId: 'stop-on-search', attempt: 0, earlierSessionIds: [] } }).then((value) => ({ value }), (error) => ({ error }));
  await stopping;
  assert.equal(outcome.error?.reason, 'aborted');
  assert.equal(search.runs, 0, 'the search never ran');
});

test("an immediate stop the host starts on submit's tool_start takes no answer: the node ends aborted", async (t) => {
  const { adapter } = await claude(t, { script: ['call submit {"value":{"answer":"not taken"}}'], sessionsDir: join(scratch(), 'sessions') });
  let stopping;
  const runner = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [], onEvent: (e) => { if (e.type === 'tool_start' && e.name === 'submit') stopping ??= runner.stop(); } });
  const outcome = await runner({ ...request, tools: [], step: { sessionId: 'stop-on-submit', attempt: 0, earlierSessionIds: [] } }).then((value) => ({ value }), (error) => ({ error }));
  await stopping;
  assert.equal(outcome.error?.reason, 'aborted', JSON.stringify(outcome).slice(0, 200));
});
