// The ACP adapter's mapping (design TDD §3.2) on the fake ACP agent: initialize against the recipe's declares, our tools
// as one loopback MCP server (HTTP or stdio), session/prompt and session/update as send() and AdapterEvents, permission
// requests through the host's gate and never an allow_always, the stop reasons, the history a load replays kept off the
// timeline, and the child's private HOME and environment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { ACP_CODES, acpAdapter } from '@parcha/agentrun-harness-acp';
import { fakeEvents, fakeRecipe, openSession, scratch, streamRecords, tool, toolEffects, until } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const texts = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');

test('a recipe that declares session/load the agent does not advertise refuses with a named code', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'hi' }], advertiseLoad: false });
  const { session } = await openSession(t, recipe);
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.capabilityMismatch}: `), end.error);
  assert.match(end.error, /session\/load/);
  assert.equal(fakeEvents(recipe).some((e) => e.type === 'prompt'), false, 'nothing was prompted');
});

test('a recipe that declares MCP over HTTP the agent does not advertise refuses with a named code', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'hi' }], advertiseHttp: false });
  const { session } = await openSession(t, recipe);
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.capabilityMismatch}: `));
  assert.match(end.error, /http/i);
});

test('a recipe that asks for plan billing names its limits, and proxy billing needs a proxy', () => {
  const base = { id: 'x', command: process.execPath, declares: { load: false, mcp: 'stdio' } };
  assert.throws(() => acpAdapter({ recipe: { ...base, billing: { kind: 'plan' } } }), /maxTurns/);
  assert.throws(() => acpAdapter({ recipe: { ...base, billing: { kind: 'proxy' } } }), /proxy/);
  assert.throws(() => acpAdapter({ recipe: { ...base, billing: { kind: 'plan', maxTurns: 1, maxToolCalls: 1 }, state: ['../outside'] } }), /inside/);
  assert.throws(() => acpAdapter({ recipe: { ...base, billing: { kind: 'plan', maxTurns: 1, maxToolCalls: 1 }, files: { '/etc/passwd': 'x' } } }), /inside/);
});

for (const http of [true, false]) {
  test(`our tools reach the agent as one MCP server over ${http ? 'HTTP' : 'stdio'}, each call once on the timeline under the agent's id`, async (t) => {
    const recipe = fakeRecipe(scratch(), { script: [{ call: 'lookup', args: { q: 'x' } }, { sayLastResult: true }], http });
    const ran = [];
    const { session, events, store } = await openSession(t, recipe, { tools: [tool('lookup', (args) => (ran.push(args), 'found it'))] });
    await session.send('go');
    const end = await session.turnEnd();
    assert.equal(end.status, 'completed', end.error);
    assert.deepEqual(ran, [{ q: 'x' }]);
    const opened = fakeEvents(recipe).find((e) => e.type === 'new');
    assert.deepEqual(opened.mcp, [http ? 'http' : 'stdio'], 'one server, on the declared transport');
    const starts = events.filter((e) => e.type === 'tool_start');
    assert.deepEqual(starts.map((e) => [e.name, e.callId]), [['lookup', 'call_0']], "one start, under the agent's own id");
    assert.deepEqual(events.filter((e) => e.type === 'tool_end').map((e) => [e.callId, e.result]), [['call_0', 'found it']]);
    assert.equal(texts(events), 'found it', 'the agent read the result');
    assert.equal((await toolEffects(store, 'lookup')).length, 1, 'one intent');
    assert.equal(events.at(-1).type, 'turn_end');
  });
}

test('a permission request for our own tool is answered allow_once, never allow_always, and the gate decides the call', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'lookup' }, { sayLastResult: true }], style: 'goose', askMcp: true });
  const asked = [];
  const { session, events } = await openSession(t, recipe, {
    tools: [tool('lookup', () => 'found')],
    gate: async (call) => (asked.push(call), { deny: 'not this one' }),
  });
  await session.send('go');
  await session.turnEnd();
  const permissions = fakeEvents(recipe).filter((e) => e.type === 'permission');
  assert.deepEqual(permissions.map((e) => e.kind), ['allow_once'], 'allowed once at the protocol, never always');
  assert.deepEqual(asked.map((c) => [c.tool, c.callId]), [['lookup', 'call_0']], 'the gate is asked about the call itself');
  assert.match(texts(events), /not this one/, "the model read the gate's words");
});

test("an agent's own tool asks the host's gate; a deny answers reject_once and the call never runs", async (t) => {
  const dir = scratch();
  const nativeLog = join(dir, 'native.log');
  const recipe = fakeRecipe(dir, { script: [{ native: 'execute', title: 'Run rm -rf /tmp/x', input: { command: 'rm -rf /tmp/x' } }, { sayLastResult: true }], style: 'cursor', nativeLog });
  const asked = [];
  const { session, store } = await openSession(t, recipe, { gate: async (call) => (asked.push(call), { deny: 'no shell' }) });
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'completed', end.error);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool, 'acp_execute');
  assert.equal(asked[0].args.title, 'Run rm -rf /tmp/x');
  assert.deepEqual(asked[0].args.input, { command: 'rm -rf /tmp/x' });
  assert.deepEqual(fakeEvents(recipe).filter((e) => e.type === 'permission').map((e) => e.kind), ['reject_once']);
  assert.throws(() => readFileSync(nativeLog, 'utf8'), /ENOENT/, 'never ran');
  const journaled = await streamRecords(store, 'acp.permission');
  assert.deepEqual(journaled.map((r) => [r.type, r.callId === asked[0].callId]), [['asked', true], ['answered', true]]);
  assert.equal(journaled[1].answer, 'deny');
});

test("an agent's own tool that asks nothing (a Cursor edit) runs without the gate, and its reported status is never trusted", async (t) => {
  const dir = scratch();
  const nativeLog = join(dir, 'native.log');
  const recipe = fakeRecipe(dir, { script: [{ native: 'edit', title: 'Edit notes.md' }, { say: 'edited' }], style: 'cursor', nativeLog });
  const asked = [];
  const { session, events } = await openSession(t, recipe, { gate: async (call) => (asked.push(call), 'allow') });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.deepEqual(asked, [], 'no permission request, so no gate');
  assert.equal(events.some((e) => e.type === 'tool_start' || e.type === 'tool_end'), false, "ACP's own report of the call is not a host call");
});

test('an answer cut at the output limit (max_tokens) completes the turn with stopReason length', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'The answer is', cut: true }] });
  const { session, events } = await openSession(t, recipe);
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'completed');
  assert.deepEqual(events.at(-1), { type: 'turn_end', status: 'completed', stopReason: 'length' });
  assert.equal(texts(events), 'The answer is');
});

test('a second turn goes to the same agent session; a load on another runner replays its history off the timeline', async (t) => {
  const store = memorySessionStore();
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'one' }, { say: 'two' }, { sayLastSteer: true }] });
  const first = await openSession(t, recipe, { store });
  await first.session.send('go');
  await first.session.turnEnd();
  await first.session.send('again');
  await first.session.turnEnd();
  assert.equal(texts(first.events), 'onetwo');
  await first.session.close();
  // Another runner: a new adapter and sessions folder, the same records.
  const second = await openSession(t, recipe, { store });
  await second.session.send('third');
  const end = await second.session.turnEnd();
  assert.equal(end.status, 'completed', end.error);
  assert.equal(texts(second.events), 'third', 'only the new answer: the replayed history stays off the timeline');
  const loaded = fakeEvents(recipe).filter((e) => e.type === 'load');
  assert.equal(loaded.length, 1, 'the agent loaded its session');
  assert.equal(loaded[0].steps, 2, 'its history came back from the mirror in the records');
});

test('with no load, a new agent process gets the conversation so far as a context note', async (t) => {
  const store = memorySessionStore();
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'one' }, { sayLastSteer: true }], load: false, http: false });
  const first = await openSession(t, recipe, { store });
  await first.session.send('go');
  await first.session.turnEnd();
  await first.session.close();
  const second = await openSession(t, recipe, { store });
  await second.session.send('second');
  assert.equal((await second.session.turnEnd()).status, 'completed');
  assert.equal(texts(second.events), 'second', 'the model went on at its next step');
  const prompts = fakeEvents(recipe).filter((e) => e.type === 'prompt');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].text[0], /^\[Context\]/);
  assert.match(prompts[1].text[0], /- user: go/);
  assert.match(prompts[1].text[0], /- assistant: one/);
  assert.equal(prompts[1].text.at(-1), 'second');
});

test("the session's instructions go as the system prompt the agent advertises, else ahead of the first prompt", async (t) => {
  const withSystem = fakeRecipe(scratch(), { script: [{ say: 'ok' }], systemPrompt: true });
  const a = await openSession(t, withSystem, { system: ['Be brief.'] });
  await a.session.send('go');
  await a.session.turnEnd();
  assert.equal(fakeEvents(withSystem).find((e) => e.type === 'new').system, 'Be brief.');
  assert.deepEqual(fakeEvents(withSystem).find((e) => e.type === 'prompt').text, ['go']);
  const without = fakeRecipe(scratch(), { script: [{ say: 'ok' }] });
  const b = await openSession(t, without, { system: ['Be brief.'] });
  await b.session.send('go');
  await b.session.turnEnd();
  const prompt = fakeEvents(without).find((e) => e.type === 'prompt').text;
  assert.equal(prompt.length, 2);
  assert.match(prompt[0], /Be brief\./);
  assert.equal(prompt[1], 'go');
});

test('the agent runs in a private HOME with the environment allowlist, in a process group of its own', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'ok' }] }, { env: { FAKE_SETTING: '1' } });
  const sessionsDir = join(scratch(), 'sessions');
  const { session } = await openSession(t, recipe, { sessionsDir, options: { env: { PATH: process.env.PATH, LANG: 'C', HOST_SECRET: 'never', OPENAI_API_KEY: 'never' } } });
  await session.send('go');
  await session.turnEnd();
  const start = fakeEvents(recipe).find((e) => e.type === 'start');
  assert.ok(start.home.startsWith(sessionsDir), `HOME is the session's own: ${start.home}`);
  const allowed = new Set(['PATH', 'LANG', 'TZ', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'GIT_CEILING_DIRECTORIES', 'FAKE_SETTING']);
  const extra = start.env.filter((name) => !allowed.has(name) && !/^(PWD|SHLVL|_)$/.test(name));
  assert.deepEqual(extra, [], 'nothing else is inherited');
  assert.ok(start.env.includes('FAKE_SETTING'), "the recipe's own env is given");
  assert.notEqual(start.pgid, Number(readFileSync('/proc/self/stat', 'utf8').replace(/^.*\) /s, '').split(' ')[2]), 'its own process group');
});

test("the agent's session store is mirrored into the records at turn end, credentials left out", async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'ok' }] }, { state: ['.fake-acp', '.config/creds'], files: { '.config/creds/token.json': '{"token":"secret"}' } });
  const { session, store } = await openSession(t, recipe);
  await session.send('go');
  await session.turnEnd();
  const mirrored = await streamRecords(store, 'acp.state');
  assert.ok(mirrored.some((r) => r.path.startsWith('.fake-acp/sessions/') && r.data), JSON.stringify(mirrored.map((r) => r.path)));
  assert.equal(mirrored.some((r) => /token/.test(r.path)), false, 'a credential file is never mirrored');
});
