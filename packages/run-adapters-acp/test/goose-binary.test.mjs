// Goose 1.59.2 itself as an AgentRun harness: the pinned binary, the shipped recipe and Goose's proxy, on the kernel's
// booking, against a fake Anthropic origin on loopback (test/fake-anthropic.mjs). No real model, no spend.
// The binary is the one AGENTRUN_TEST_GOOSE names, and nothing else; without it every test here skips and says why.
// What each proves:
//  (a) the first model request offers only our tools and Goose's load_skill;
//  (b) the child's environment is the allowlist and the recipe's variables, nothing else;
//  (c) no side request: the origin sees only the turn's own requests, the models list is answered by the proxy, and
//      what Goose reaches for beyond loopback goes only to the egress proxy the recipe names;
//  (d) a kill -9 mid-session, then a new process loads the session and the run goes on, in this runner and another;
//  (e) a denied tool call never runs, and the model is told;
//  (f) our tool, called over MCP, with its result on the timeline;
//  (g) the cap: a request past the run's money cap is refused unsent, the turn stops, and each answered request is booked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { modelPortFor, RUNNER_RECORDS } from '@parcha/agentrun-kernel';
import { beforeRequestOf } from '@parcha/agentrun-kernel/kernel/cap';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { acpAdapter, GOOSE_BETAS, gooseAdapter, gooseProxy, gooseRecipe, recipeFile, PERMISSION_STREAM, RESERVED_ENV, STATE_STREAM } from '@parcha/agentrun-harness-acp';
import { fakeAnthropic, recordingProxy } from './fake-anthropic.mjs';
import { scratch, streamRecords, toolEffects, transcript, until } from './helpers.mjs';

const GOOSE = process.env.AGENTRUN_TEST_GOOSE;
const skip = GOOSE ? false : 'AGENTRUN_TEST_GOOSE is not set: it names the Goose 1.59.2 binary these tests run';
const test = (name, fn) => nodeTest(name, { skip, timeout: 180_000 }, fn);

const MODEL = 'claude-sonnet-5-5';
const PROVIDER_KEY = 'provider-key-goose-never-holds';
/** $3 in, $15 out per million tokens. */
const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const price = (_model, u) => (u.input * RATES.input + u.output * RATES.output + u.cacheRead * RATES.cacheRead + (u.cacheWrite ?? 0) * RATES.cacheWrite) / 1e6;
const capModel = (id) => ({ id, api: 'anthropic-messages', price: RATES, outputCeiling: 128000, reasoning: true });

/** The host's echo tool, its calls counted. */
function echoTool() {
  const calls = [];
  return { calls, tool: { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, replay: 'never', call: async (args) => (calls.push(args), { text: `ECHO:${args.text}` }) } };
}

/** The environment a host passes: the allowlist's names, and what must never reach the agent. */
const HOST_ENV = { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', HOST_CANARY: 'never-inherited', ANTHROPIC_API_KEY: 'the-parent-process-key', OPENAI_API_KEY: 'never', GOOSE_PROVIDER: 'openai' };

/** A Goose session on `store` under key s1, booked by the kernel's model port on the session's writer. `egress`: the
 *  proxy the recipe's HTTP(S)_PROXY name in place of its dead port, so what Goose reaches for is seen. */
async function gooseSession(t, { origin, store = memorySessionStore(), sessionsDir = join(scratch(), 'sessions'), gate = async () => 'allow', cap, egress, tools = [echoTool().tool] } = {}) {
  const logs = [];
  const log = (message, fields) => logs.push({ message, ...(fields ?? {}) });
  const provider = { origin: origin.url, credential: () => PROVIDER_KEY };
  let adapter;
  if (egress) {
    const recipe = gooseRecipe({ command: GOOSE, model: MODEL });
    const env = { ...recipe.env };
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) env[name] = egress;
    adapter = acpAdapter({ recipe: { ...recipe, env }, sessionsDir, env: HOST_ENV, log, proxy: gooseProxy({ model: MODEL, provider, price, log }) });
  } else {
    adapter = gooseAdapter({ binary: GOOSE, model: MODEL, provider, price, sessionsDir, env: HOST_ENV, log });
  }
  const writer = await store.open('s1');
  const ends = [];
  const refused = [];
  const booking = await modelPortFor(writer, {
    key: 's1',
    ...(cap === undefined ? {} : { beforeRequest: beforeRequestOf({ capUsd: () => cap, modelOf: capModel }) }),
    onEvent: (event) => { if (event.type === 'request_end') ends.push(event); },
    stop: (reason, message, code) => { refused.push({ reason, message, code }); return new Error(`${code ?? reason}: ${message ?? ''}`); },
  });
  const events = [];
  const controller = new AbortController();
  const io = { writer, models: booking.models, signal: controller.signal, onEvent: (event) => events.push(event), gate };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools, context: 'fresh' }, io);
  t.after(() => session.close());
  const turn = async (text) => {
    await session.send(text);
    return session.turnEnd();
  };
  const opened = () => logs.filter((l) => l.message === "acp: the agent's session is open");
  return { session, turn, events, logs, opened, booking, ends, refused, writer, store, stop: (reason) => controller.abort(reason) };
}

async function originFor(t, options) {
  const origin = await fakeAnthropic(options);
  t.after(() => origin.close());
  return origin;
}

const toolNames = (request) => (request.body.tools ?? []).map((tool) => tool.name).sort();
const blocksOf = (request) => request.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]));

test('(a) the first model request offers only our tools, as agentrun__<name>, and Goose\'s load_skill; with its one beta and never its session id', async (t) => {
  const origin = await originFor(t);
  const { turn } = await gooseSession(t, { origin });
  const end = await turn('SAY first');
  assert.equal(end.status, 'completed', end.error);
  const [first] = origin.messages();
  assert.ok(first, 'a model request reached the origin');
  assert.deepEqual(toolNames(first), ['agentrun__echo', 'load_skill']);
  assert.equal(first.body.model, MODEL);
  const betas = String(first.headers['anthropic-beta'] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  t.diagnostic(`anthropic-beta: ${betas.join(',')}`);
  assert.ok(betas.length > 0 && betas.every((v) => GOOSE_BETAS.has(v)), `the betas Goose sent: ${betas}`);
  assert.equal(first.headers['agent-session-id'], undefined);
  assert.equal(first.headers['x-api-key'], PROVIDER_KEY, "the provider's key, added by the proxy");
});

test('(b) Goose\'s environment is the allowlist, the reserved names and the recipe\'s variables, and nothing else', async (t) => {
  const origin = await originFor(t);
  const { turn, opened } = await gooseSession(t, { origin });
  assert.equal((await turn('SAY env')).status, 'completed');
  const pid = opened()[0].pid;
  assert.equal(readFileSync(`/proc/${pid}/comm`, 'utf8').trim(), 'goose', 'the pid is Goose itself');
  const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const recipe = gooseRecipe({ command: GOOSE, model: MODEL });
  const expected = new Set(['PATH', 'LANG', 'TZ', ...RESERVED_ENV, ...Object.keys(recipe.env), 'ANTHROPIC_HOST', 'ANTHROPIC_API_KEY']);
  assert.deepEqual(Object.keys(env).filter((name) => !expected.has(name)).sort(), [], 'nothing beyond the allowlist and the recipe');
  for (const name of ['PATH', 'LANG', 'TZ', 'HOME', 'TMPDIR', 'GOOSE_MODEL', 'ANTHROPIC_HOST', 'ANTHROPIC_API_KEY', ...Object.keys(recipeFile('goose').env)]) assert.ok(name in env, `${name} is set`);
  for (const [name, value] of Object.entries(recipe.env)) assert.equal(env[name], value, name);
  assert.equal(env.GOOSE_PROVIDER, 'anthropic', "the recipe's, never the host's");
  assert.notEqual(env.ANTHROPIC_API_KEY, HOST_ENV.ANTHROPIC_API_KEY, "the proxy's key, never the parent's");
  assert.notEqual(env.ANTHROPIC_API_KEY, PROVIDER_KEY);
  assert.match(env.ANTHROPIC_HOST, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(env.HOST_CANARY, undefined);
});

test('(c) no side requests: the origin sees only the turns\' own requests, the models list is answered by the proxy, and beyond loopback Goose reaches only the egress proxy', async (t) => {
  const origin = await originFor(t);
  const egress = await recordingProxy();
  t.after(() => egress.close());
  const { turn, logs } = await gooseSession(t, { origin, egress: egress.url });
  assert.equal((await turn('SAY one')).status, 'completed');
  assert.equal((await turn('CALL_ECHO please')).status, 'completed');
  // One request for the first turn; the call and the answer after its result for the second.
  assert.deepEqual(origin.requests.map((r) => `${r.method} ${r.path}`), ['POST /v1/messages', 'POST /v1/messages', 'POST /v1/messages']);
  const refusals = logs.filter((l) => /refus/i.test(l.message));
  t.diagnostic(`the proxy's refusals: ${JSON.stringify(refusals)}`);
  t.diagnostic(`beyond loopback: ${JSON.stringify(egress.asked)}`);
  // What Goose reaches for beyond loopback: its model catalog at start, and nothing of the conversation.
  const targets = new Set(egress.asked.map((a) => a.target));
  assert.deepEqual([...targets].filter((target) => target !== 'models.dev:443'), [], 'only the model catalog');
});

test('(d) kill -9 mid-session: the next turn starts a new Goose that loads the session, and so does another runner from the mirror', async (t) => {
  const origin = await originFor(t);
  const store = memorySessionStore();
  const first = await gooseSession(t, { origin, store });
  assert.equal((await first.turn('CALL_ECHO first')).status, 'completed');
  const pid = first.opened()[0].pid;
  process.kill(pid, 'SIGKILL');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'Goose to be gone');
  const second = await first.turn('SAY again');
  assert.equal(second.status, 'completed', second.error);
  const [one, two] = first.opened();
  assert.notEqual(two.pid, one.pid, 'a new process');
  assert.equal(two.loaded, true, 'it loaded the session');
  assert.equal(two.sessionId, one.sessionId);
  // The model's request carries the first turn: the call, its result.
  const after = origin.messages().at(-1);
  const texts = JSON.stringify(blocksOf(after));
  assert.match(texts, /CALL_ECHO first/);
  assert.match(texts, /ECHO:hello from the fake model/);
  assert.match(texts, /SAY again/);
  await first.session.close();
  // Another runner, its own sessions directory: the session comes back from the records' mirror.
  const other = await gooseSession(t, { origin, store, sessionsDir: join(scratch(), 'elsewhere') });
  const third = await other.turn('SAY onward');
  assert.equal(third.status, 'completed', third.error);
  assert.equal(other.opened()[0].loaded, true, 'loaded from the mirror');
  assert.equal(other.opened()[0].sessionId, one.sessionId);
  const last = JSON.stringify(blocksOf(origin.messages().at(-1)));
  assert.match(last, /CALL_ECHO first/);
  assert.match(last, /SAY again/);
  assert.match(last, /SAY onward/);
  // Goose's session files are in the records (as blobs: each is larger than a record holds inline).
  assert.ok((await streamRecords(store, STATE_STREAM)).length > 0, "Goose's sessions are in the records");
});

test('(e) a denied tool call never runs and the model is told; a denied load_skill too, Goose\'s own permission request answered deny', async (t) => {
  const origin = await originFor(t);
  const asked = [];
  const echo = echoTool();
  const gate = async (call) => (asked.push(call), { deny: 'not in this run' });
  const { turn, events, store } = await gooseSession(t, { origin, gate, tools: [echo.tool] });
  assert.equal((await turn('CALL_ECHO please')).status, 'completed');
  assert.equal(echo.calls.length, 0, 'the tool never ran');
  assert.equal(asked[0].tool, 'echo');
  const result = blocksOf(origin.messages()[1]).find((b) => b.type === 'tool_result');
  assert.ok(result, 'the model got a result for its call');
  assert.match(JSON.stringify(result), /declined|denied|not in this run/i, JSON.stringify(result));
  const ended = events.filter((e) => e.type === 'tool_end');
  t.diagnostic(`tool_end events: ${JSON.stringify(ended)}`);
  assert.ok(ended.every((e) => e.isError !== false), 'no call ended as a success');
  assert.equal((await turn('CALL_SKILL please')).status, 'completed');
  const skill = asked.find((c) => c.tool !== 'echo');
  assert.ok(skill, 'load_skill asked the gate');
  t.diagnostic(`load_skill at the gate: ${JSON.stringify(skill)}`);
  assert.match(JSON.stringify(skill.args), /fake-skill/);
  const skillResult = blocksOf(origin.messages().at(-1)).find((b) => b.type === 'tool_result');
  assert.match(JSON.stringify(skillResult), /declined|denied|not in this run/i);
  // Goose's own permission request, answered deny (the adapter's reject_once) in the records.
  const journaled = (await streamRecords(store, PERMISSION_STREAM)).filter((r) => r.callId === skill.callId);
  assert.deepEqual(journaled.map((r) => [r.type, r.answer]), [['asked', undefined], ['answered', 'deny']]);
});

test('(f) our tool, called by the model over MCP, runs once, and its result is on the timeline and back to the model', async (t) => {
  const origin = await originFor(t);
  const echo = echoTool();
  const asked = [];
  const { turn, events, store } = await gooseSession(t, { origin, gate: async (call) => (asked.push(call), 'allow'), tools: [echo.tool] });
  assert.equal((await turn('CALL_ECHO please')).status, 'completed');
  assert.deepEqual(echo.calls, [{ text: 'hello from the fake model' }]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool, 'echo');
  const start = events.find((e) => e.type === 'tool_start');
  const end = events.find((e) => e.type === 'tool_end');
  assert.ok(start && end, JSON.stringify(events.map((e) => e.type)));
  assert.match(JSON.stringify(end), /ECHO:hello from the fake model/);
  assert.equal((await toolEffects(store, 'echo')).length, 1, 'one effect of the call in the records');
  assert.match(JSON.stringify(await transcript(store)), /TOOL_RESULT_SEEN/);
  const result = blocksOf(origin.messages()[1]).find((b) => b.type === 'tool_result');
  assert.match(JSON.stringify(result), /ECHO:hello from the fake model/);
});

test('(g) the cap: each answered request is booked at its price; one past the cap is refused unsent and the turn stops', async (t) => {
  // Each answer reports 1,000 tokens in and its whole max_tokens out, less 10: a turn spends nearly all the cap leaves it.
  const origin = await originFor(t, { usage: (body) => ({ input_tokens: 1000, output_tokens: Math.max(1, body.max_tokens - 10) }) });
  const cap = 1;
  const { turn, booking, ends, writer, refused } = await gooseSession(t, { origin, cap });
  const first = await turn('SAY first');
  assert.equal(first.status, 'completed', first.error);
  assert.equal(origin.messages().length, 1);
  const limited = origin.messages()[0].body.max_tokens;
  t.diagnostic(`the first request's max_tokens under a $${cap} cap: ${limited}`);
  assert.ok(limited < 128000, 'the cap limited its output');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].usage.usd, price(MODEL, ends[0].usage));
  const spent = booking.spentUsd();
  assert.ok(spent > 0.5 && spent <= cap, `spent ${spent}`);
  const second = await turn('SAY second');
  t.diagnostic(`the turn past the cap: ${JSON.stringify(second)}`);
  assert.notEqual(second.status, 'completed', 'the turn stopped');
  assert.equal(origin.messages().length, 1, 'nothing past the cap reached the provider');
  assert.equal(ends.length, 1, 'nothing more was booked');
  assert.equal(booking.spentUsd(), spent);
  assert.ok(refused.length > 0 || /spend_cap|cap/i.test(second.error ?? ''), `the refusal: ${JSON.stringify(refused)} ${second.error}`);
  const turns = (await writer.read()).filter((r) => r.kind === RUNNER_RECORDS.turn);
  assert.equal(turns.length, 1, 'one runner.turn per answered request');
});
