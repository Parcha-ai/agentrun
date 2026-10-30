// How the parts of code-mode recovery are wired to each other: each test would still pass if one of these links were cut
// in the harness and nothing else changed, unless it holds that link.
//  - RG: a cut-off exec's nested call reads its outcome from the rollout's item_completed when the store has no end for it.
//  - WF2: an answer the proxy could not watch leaves no real exec announced, so a nested call is not tied to an earlier exec.
//  - RI: a never call's "recorded earlier" answer belongs to the recovered turn; a later turn's same call runs.
//  - RC: a cut-off exec's nested calls are reported in the order they were made.
//  - SP4: an event too long in sum, though each of its lines is short, leaves the answer unwatched.
//  - N4: a recovery note injected and then lost with the process (its rollout line never reached the store) is injected again,
//    so the history holds it exactly once.
// The pinned binary (WF2 needs none), through the adapter, with a scripted Responses provider behind the session's proxy.
// No network. Without the binary the binary's tests skip; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing one fails.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { codexAdapter } from '@parcha/agentrun-codex';
import { findCodex } from '../dist/binary.js';
import { localMachine } from '../dist/host/machine.js';
import { CODEX_ROUTES, gatewayHandler } from '../dist/host/process.js';
import { Scripts, UNWATCHED } from '../dist/scripts.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const skip = problem && env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-wiring-'));
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
const adapter = (fetch) => codexAdapter({ model: MODEL, provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: mkdtempSync(join(ROOT, 'box-')), fetch });
/** What the model was told about `callId`'s outcome, from the requests it was sent. */
const toldAbout = (seen, callId) => seen.flatMap((body) => body.input ?? []).filter((item) => item.call_id === callId && /_output$/.test(item.type ?? '')).map((item) => (Array.isArray(item.output) ? item.output.map((o) => o.text ?? '').join('\n') : String(item.output)));

/**
 * A session whose first exec runs `js` (it ends in a call to `hold`, a never tool that never returns), then the process
 * dies there; a fresh box recovers the turn from the store alone. `keep(record)` says which of the first process's records
 * reach the store. `after(seen, n)` answers each request made after the resume. Returns the calls made and what was sent.
 */
async function cutOff({ js, keep = () => true, after = (_seen, n) => [say(n)], tools = [], next, queue, settled }) {
  const calls = [];
  let holding;
  const held = new Promise((resolve) => { holding = resolve; });
  const charge = { name: 'charge', description: 'Charge the card once.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: async (args) => { calls.push(['charge', args.amount]); return { text: `charged ${args.amount}` }; } };
  // A never tool: its barrier syncs the log, so the calls before it are in the store before it runs; it then waits until the process dies.
  const hold = { name: 'hold', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'never', call: (_args, { signal }) => { holding(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:wiring', label: 'pay', system: [], tools: [charge, hold, ...tools], context: 'fresh' };
  const store = memorySessionStore();
  const seen = [];
  let resumed = false;
  let b;
  let queued = false;
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    // While the recovered turn runs: a new message arrives. A prompt is not steered into a running turn: it is the next
    // turn, once the recovered one ends.
    if (resumed && queue && !queued) {
      queued = true;
      void b.send(queue);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const items = n === 1 ? [exec('call_js', js)] : resumed ? after(seen, n) : [say(n)];
    return new Response(sse(n, items), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const writer = await store.open(spec.key);
  const filtered = { key: writer.key, read: () => writer.read(), append: (records) => writer.append(records.filter(keep)) };
  const died = new AbortController();
  const a = await adapter(fetch).open(spec, { writer: filtered, models: MODELS, signal: died.signal, onEvent: () => {} });
  await a.send('pay');
  await held;
  died.abort(new Error('the process died'));
  await a.turnEnd();
  await a.close();
  const before = seen.length;
  resumed = true;
  b = await adapter(fetch).open(spec, { writer: await store.open(spec.key), models: MODELS, signal: new AbortController().signal, onEvent: () => {} });
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed', 'the recovered turn completes');
  for (const end = Date.now() + 120_000; settled && !settled(calls, seen) && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 100));
  if (settled) assert.equal((await b.turnEnd()).status, 'completed', 'the next turn completes');
  if (next) await next(b);
  await b.close();
  return { calls, seen, before };
}
/** The text the cut-off exec was answered with on the resume. */
const recoveredText = (r) => toldAbout(r.seen.slice(r.before), 'call_js').join('\n');

test("RG: a cut-off exec's nested call whose end the store lost reads its outcome from the rollout's item_completed: completed, not started-without-a-result", { skip, timeout: 240_000 }, async () => {
  // The store never gets the end of charge's step: a crash between the tool's return and that record's commit.
  const charges = new Set();
  const keep = (record) => {
    if (record.kind === 'kernel.start' && record.data?.name === 'tool.charge') charges.add(record.data.stepId);
    return !(record.kind === 'kernel.end' && charges.has(record.data?.stepId));
  };
  const r = await cutOff({ js: `text('charge: ' + JSON.stringify(await tools.charge({ amount: 1 })));\nawait tools.hold({});`, keep });
  assert.deepEqual(r.calls, [['charge', 1]], 'the charge ran once, before the crash, and not again');
  const told = recoveredText(r);
  assert.match(told, /1\. charge completed: "charged 1"/, `the outcome is the rollout's completion: ${told}`);
  assert.doesNotMatch(told, /1\. charge was started and did not report a result/);
});

test("RC: a cut-off exec's nested calls are reported in the order they were made, each with its own result", { skip, timeout: 240_000 }, async () => {
  const r = await cutOff({ js: `text(JSON.stringify(await tools.charge({ amount: 1 })));\ntext(JSON.stringify(await tools.charge({ amount: 2 })));\nawait tools.hold({});` });
  assert.deepEqual(r.calls, [['charge', 1], ['charge', 2]], 'each ran once, in order');
  const told = recoveredText(r);
  assert.match(told, /1\. charge completed: "charged 1"/, told);
  assert.match(told, /2\. charge completed: "charged 2"/, told);
  assert.ok(told.indexOf('charged 1') < told.indexOf('charged 2'), 'in the order they were made');
});

test("RI: a never call answered \"recorded earlier\" in the recovered turn is a fact of that turn only: a message sent during it runs its own same call", { skip, timeout: 300_000 }, async () => {
  let again = 0;
  const r = await cutOff({
    js: `text(JSON.stringify(await tools.charge({ amount: 5 })));\nawait tools.hold({});`,
    // A message that arrives while the recovered turn runs asks for the charge again: its turn comes right after the
    // recovered one, and its model charges 5 again, as the user asked. (The adapter's send waits for the running drive, so
    // that turn is a drive of its own; a host that submits into a running drive would take it in the same one.)
    queue: 'charge 5 again',
    after: (seen, n) => {
      const users = (seen[n - 1].input ?? []).filter((it) => it.role === 'user');
      const last = JSON.stringify(users.at(-1)?.content ?? '');
      return last.includes('charge 5 again') && !last.includes('[Recovery]') && again++ === 0 ? [exec('call_again', `text(JSON.stringify(await tools.charge({ amount: 5 })));`)] : [say(n)];
    },
    settled: (_calls, seen) => seen.some((body) => (body.input ?? []).some((item) => item.call_id === 'call_again' && /_output$/.test(item.type ?? ''))),
  });
  assert.ok(toldAbout(r.seen, 'call_again').length > 0, 'the next turn made its own charge call');
  assert.deepEqual(r.calls, [['charge', 5], ['charge', 5]], 'the next turn ran its own charge');
  assert.doesNotMatch(toldAbout(r.seen, 'call_again').join('\n'), /Recorded earlier in this turn/, 'it was not answered from the recovered turn');
});

/** The machine's model proxy in front of `fetch` (the provider), and `ask()`, which sends it one streamed request and reads the answer to its end. */
async function proxied(fetch, runId) {
  const acquire = localMachine({ dir: mkdtempSync(join(ROOT, `${runId}-`)), proxy: { hooks: MODELS, tools: [], fetch } });
  const route = { routes: CODEX_ROUTES, models: { model: MODEL }, credential: () => 'provider-secret', target: 'https://provider.invalid' };
  const machine = await acquire({ ctx: { runId }, model: gatewayHandler(route) });
  const ask = async () => {
    const res = await globalThis.fetch(`${machine.modelUrl}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${machine.modelKey}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ model: MODEL, input: [], stream: true }) });
    await res.text();
    return res.status;
  };
  return { machine, ask };
}

test("WF2: an answer the proxy could not watch leaves no real exec announced, so a nested call is not tied to an exec still open from before", async () => {
  // The machine's proxy, with a provider whose first answer carries exec call_prev and whose second answer the watcher
  // cannot follow: one of its events is longer than any it reads (over 4 MiB), so it stops watching that answer.
  let n = 0;
  const fetch = async () => {
    n += 1;
    const items = n === 1 ? [exec('call_prev', 'text(1)')] : [{ type: 'message', role: 'assistant', id: 'msg_x', content: [{ type: 'output_text', text: 'x'.repeat(5 * 1024 * 1024) }] }];
    return new Response(sse(n, items), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { machine, ask } = await proxied(fetch, 'wf2');
  try {
    assert.equal(await ask(), 200);
    assert.equal(machine.announcedExec(), 'call_prev', 'a watched answer announces its exec');
    assert.equal(await ask(), 200, 'the answer the watcher stopped on still reaches the client');
    const announced = machine.announcedExec();
    assert.notEqual(announced, 'call_prev', 'the earlier exec is not taken for this answer');
    assert.ok(announced !== undefined && !/^call_/.test(announced), `no real exec id is announced: ${JSON.stringify(announced)}`);
    // call_prev's script is still open (it yielded): a nested call now must not be tied to it.
    const scripts = new Scripts();
    scripts.note(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_prev', input: 'text(1)' } }));
    const tie = scripts.tie(announced, () => true);
    assert.ok(!(tie.kind === 'tied' && tie.exec === 'call_prev'), `not tied to the earlier exec: ${JSON.stringify(tie)}`);
    assert.equal(announced, UNWATCHED);
  } finally {
    await machine.close?.();
  }
});

test("SP4: an answer whose event is too long in sum, though each of its lines is short, reads as unwatched: the exec it carries is not announced", async () => {
  // The second answer's exec event comes as many data lines, each 1 MiB (under the 4 MiB the watcher reads at once), 6 MiB in
  // all. Joined, they are one JSON event that carries exec call_hidden.
  const pad = 'x'.repeat(1024 * 1024);
  const lines = ['{"type":"response.output_item.done"', ...Array.from({ length: 6 }, (_, i) => `,"pad${i}":"${pad}"`), `,"item":${JSON.stringify(exec('call_hidden', 'text(2)'))}}`];
  JSON.parse(lines.join('\n'));
  const split = `event: response.output_item.done\n${lines.map((line) => `data: ${line}`).join('\n')}\n\n`;
  let n = 0;
  const fetch = async () => {
    n += 1;
    const body = n === 1 ? sse(n, [exec('call_prev', 'text(1)')]) : sse(n, []).replace('event: response.completed', `${split}event: response.completed`);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { machine, ask } = await proxied(fetch, 'sp4');
  try {
    assert.equal(await ask(), 200);
    assert.equal(machine.announcedExec(), 'call_prev', 'a watched answer announces its exec');
    assert.equal(await ask(), 200, 'the answer still reaches the client');
    const announced = machine.announcedExec();
    assert.notEqual(announced, 'call_hidden', 'the exec of an event the watcher could not hold is not announced as read');
    assert.equal(announced, UNWATCHED, `the answer reads as unwatched: ${JSON.stringify(announced)}`);
  } finally {
    await machine.close?.();
  }
});

test("N4: a recovery note injected, then lost with the process before its rollout line reached the store, is injected again: the next model request holds it exactly once, as a developer message", { skip, timeout: 300_000 }, async () => {
  const NOTE = 'The harness, not the user, adds this about the turn before this one';
  let holding;
  const held = new Promise((resolve) => { holding = resolve; });
  const hold = { name: 'hold', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'never', call: (_args, { signal }) => { holding(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:n4', label: 'wait', system: [], tools: [hold], context: 'fresh' };
  const store = memorySessionStore();
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    return new Response(sse(n, n === 1 ? [exec('call_js', 'await tools.hold({});')] : [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  // 1. The turn is cut off inside its exec.
  const died = new AbortController();
  const a = await adapter(fetch).open(spec, { writer: await store.open(spec.key), models: MODELS, signal: died.signal, onEvent: () => {} });
  await a.send('wait');
  await held;
  died.abort(new Error('the process died'));
  await a.turnEnd();
  await a.close();
  // 2. A second process recovers: it injects the note, and dies while the write that carries the note's rollout line to the
  // store is held. That write never commits.
  const writer = await store.open(spec.key);
  const died2 = new AbortController();
  let opened;
  const gate = new Promise((resolve) => { opened = resolve; });
  const gated = {
    key: writer.key,
    read: () => writer.read(),
    append: (records) => {
      if (!records.some((record) => JSON.stringify(record).includes(NOTE))) return writer.append(records);
      opened();
      return new Promise((_, reject) => died2.signal.addEventListener('abort', () => reject(died2.signal.reason), { once: true }));
    },
  };
  const b = await adapter(fetch).open(spec, { writer: gated, models: MODELS, signal: died2.signal, onEvent: () => {} });
  const asked = seen.length;
  await b.recover();
  await gate;
  died2.abort(new Error('the process died'));
  await b.turnEnd();
  await b.close();
  assert.equal(seen.length, asked, 'the second process died before it asked the model anything');
  // 3. A third process recovers from the store alone.
  const c = await adapter(fetch).open(spec, { writer: await store.open(spec.key), models: MODELS, signal: new AbortController().signal, onEvent: () => {} });
  await c.recover();
  assert.equal((await c.turnEnd()).status, 'completed', 'the recovered turn completes');
  await c.close();
  const request = seen[asked];
  assert.ok(request, 'the third process asked the model');
  const said = (role) => (request.input ?? []).filter((item) => item.role === role && JSON.stringify(item.content ?? '').includes(NOTE)).length;
  assert.equal(said('developer'), 1, 'the note is in the history once, as a developer message: never lost, never twice');
  assert.equal(said('user'), 0, 'the note is in no user message');
});
