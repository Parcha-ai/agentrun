// The Claude Agent adapter behind createHarnessRunner, as a DSL host runs it, on the scripted Agent SDK (./testing): its
// "CLI" child makes each model request through the session's real proxy to a scripted Anthropic API. No key, no network,
// no Claude Agent CLI.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createHarnessRunner, RUNNER_RECORDS } from '@parcha/agentrun-kernel';
import { foldSession, openDrive, pendingSubmissions } from '@parcha/agentrun-kernel/kernel';
import { transcriptOf } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { ClaudeAgentThinkingOff, claudeAgentAdapter, thinkingOf } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

/** The follow-up 'and now?' after a stopped 'go', as it is placed and sent: the stopped prompt, its line, then its own. */
const CARRIED = 'go\n\n(The message above was stopped before any work on it began.)\n\nand now?';
const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
const doc = (root) => ({ v: 2, name: 'claude', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root });
const agent = (extra = {}) => ({ node: 'agent', label: 'task', instructions: 'Answer.', out: 'Out', as: 'final', ...extra });

/** A Claude Agent adapter on the scripted SDK, whose "model" is a scripted Anthropic API behind the session's proxy. */
/** Wait until `ready()` holds, or fail after 5 s naming `what`. */
async function until(ready, what) {
  for (const end = Date.now() + 5_000; !ready(); await new Promise((resolve) => setTimeout(resolve, 5))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

async function claude(t, { script = [], sdk: sdkOptions = {}, ...extra } = {}) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const sdk = fakeSdk({ remoteModel: true, mirrorLagMs: 10, script, ...sdkOptions });
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: (_model, usage) => (usage.input + usage.output) / 1e6,
    sessionsDir: join(scratch(), 'sessions'),
    // The scripted SDK's "CLI" is a node child, a stand-in no pin is checked against (tests only).
    standIn: { command: process.execPath },
    sdk,
    ...extra,
  });
  return { adapter, provider, sdk };
}

test('a DSL agent node runs on the Claude Agent adapter: the host tool, then submit, each model request through the proxy', async (t) => {
  const calls = [];
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async (args) => { calls.push(args); return { text: 'found' }; } };
  const { adapter, provider } = await claude(t, { script: ['call lookup {"q":"x"}', 'call submit {"value":{"answer":"found"}}'] });
  const store = memorySessionStore();
  const events = [];
  const runNode = createHarnessRunner(adapter, { store, tools: [lookup], onEvent: (e) => events.push(e) });
  const result = await runWorkflow(doc(agent({ tools: ['lookup'] })), {}, { runNode });

  assert.equal(result.status, 'complete', JSON.stringify(result.error ?? null));
  assert.deepEqual(result.output, { answer: 'found' });
  assert.deepEqual(calls, [{ q: 'x' }]);
  // The host saw its own tools, by their own names.
  assert.deepEqual(events.filter((e) => e.type === 'tool_start').map((e) => e.name), ['lookup', 'submit']);
  // Every model request reached the provider through the proxy: its one route, the session's model, the provider's key.
  const asked = provider.messages();
  assert.ok(asked.length >= 2, `${asked.length} model requests`);
  for (const r of asked) {
    assert.deepEqual([r.path, r.query, r.model, r.authorized], ['/v1/messages', 'beta=true', 'claude-test', true]);
  }
  // Each was admitted by the runner before it left, and its cost came back.
  const [key] = store.keys();
  const records = await store.read(key);
  assert.equal(records.filter((r) => r.kind === RUNNER_RECORDS.request).length, asked.length);
  assert.equal(records.filter((r) => r.kind === RUNNER_RECORDS.turn).length, asked.length);
  assert.ok(records.filter((r) => r.kind === RUNNER_RECORDS.turn).every((r) => typeof r.data.usd === 'number' && r.data.usd > 0));
});

test("the CLI is started with the host's tools only, no settings, no sign-in and no provider key", async (t) => {
  const seen = [];
  const { adapter } = await claude(t, { script: ['call submit {"value":{"answer":"ok"}}'], sdk: { onQuery: (options) => seen.push(options) } });
  const lookup = { name: 'lookup', description: 'Look.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'x' }) };
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup] });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'q', system: ['Be brief.'], user: 'Go.', schema: SCHEMAS.Out, tools: ['lookup'] }), { answer: 'ok' });
  const [options] = seen;
  // No built-in tool, and the ones that keep state outside the transcript or start other agents are off by name too.
  assert.deepEqual(options.tools, []);
  for (const name of ['Task', 'Agent', 'WebSearch', 'CronCreate', 'ScheduleWakeup', 'EnterWorktree', 'SendMessage', 'TaskCreate', 'Monitor', 'BashOutput', 'Workflow', 'AskUserQuestion']) assert.ok(options.disallowedTools.includes(name), name);
  assert.deepEqual([...options.allowedTools].sort(), ['mcp__hands__lookup', 'mcp__hands__submit']);
  assert.deepEqual(Object.keys(options.mcpServers), ['hands']);
  assert.deepEqual([options.permissionMode, options.strictMcpConfig, options.settingSources], ['dontAsk', true, []]);
  assert.equal(options.sandbox, undefined);
  assert.ok(options.hooks?.PreToolUse?.length, 'the PreToolUse gate is installed');
  assert.ok(options.sessionStore, "the transcript is mirrored into the session's records");
  // The CLI's environment: the session's own dirs, its proxy and per-session key; no provider key, token or sign-in.
  const env = options.env;
  assert.match(env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_AUTH_TOKEN !== 'provider-secret');
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_ACCESS_KEY_ID']) assert.equal(env[name], undefined, name);
  assert.ok(!Object.values(env).includes('provider-secret'));
  assert.ok(!Object.values(env).some((v) => typeof v === 'string' && v.includes('/.claude')), "never the operator's ~/.claude");
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'agentrun-claude-agent');
});

// The Skill gate apart from the CLI. On the pinned CLI a name that is no skill of the session's never reaches the hook (the
// CLI refuses it first), so the hook's own deny is the last line should a later CLI check in another order; and the
// rewrite of a bare name is pinned here without the CLI too.
test("the Skill gate: a session skill by its qualified name is allowed as asked, by its bare name rewritten to the qualified one (never a bare name the CLI keeps), and any other name denied", async (t) => {
  const seen = [];
  const out = {};
  const skill = (name) => ({ name, files: { 'SKILL.md': `---\nname: ${name}\ndescription: d\n---\nbody\n` } });
  const probe = { name: 'probe', description: 'Probe the gate.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => {
    const [gate] = seen[0].hooks.PreToolUse[0].hooks;
    const ask = (skillName) => gate({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/', tool_name: 'Skill', tool_input: { skill: skillName, args: 'x' }, tool_use_id: `toolu_${skillName}` }, `toolu_${skillName}`, { signal: new AbortController().signal });
    for (const name of ['agentrun:research-method', 'research-method', 'research-methods', 'simplify', 'agentrun:simplify', 'agentrun:review', 'review']) out[name] = (await ask(name))?.hookSpecificOutput;
    return { text: 'probed' };
  } };
  // A user's skill named "review" (a name the CLI keeps) is the session's, by its qualified name only.
  const { adapter } = await claude(t, { skills: [skill('research-method'), skill('review')], script: ['call probe {}', 'call submit {"value":{"answer":"ok"}}'], sdk: { onQuery: (options) => seen.push(options) } });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [probe] });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'q', system: [], user: 'Go.', schema: SCHEMAS.Out, tools: ['probe'] }), { answer: 'ok' });
  assert.deepEqual(out['agentrun:research-method'], { hookEventName: 'PreToolUse', permissionDecision: 'allow' }, 'the qualified name, as asked');
  assert.deepEqual(out['research-method'], { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { skill: 'agentrun:research-method', args: 'x' } }, 'the bare name, rewritten');
  assert.deepEqual(out['agentrun:review'], { hookEventName: 'PreToolUse', permissionDecision: 'allow' }, "a reserved name's skill, by its qualified name");
  for (const name of ['research-methods', 'simplify', 'agentrun:simplify', 'review']) {
    assert.equal(out[name]?.permissionDecision, 'deny', name);
    assert.match(out[name]?.permissionDecisionReason ?? '', /not one of this session's skills/, name);
  }
});

test("a host header the proxy would refuse is refused when the adapter is made, by the adapter, naming the header", () => {
  const make = (headers) => claudeAgentAdapter({ model: 'm', provider: { origin: 'https://x.invalid', credential: () => 'k', headers }, sdk: fakeSdk(), standIn: { command: process.execPath } });
  assert.throws(() => make({ Authorization: 'x' }), /^Error: agentrun-harness-claude: provider\.headers: .*authorization/i);
  assert.throws(() => make({ 'x-tags': 'a\r\nb' }), /agentrun-harness-claude: provider\.headers: /);
  assert.doesNotThrow(() => make({ 'x-litellm-tags': 'job:1' }));
});

test("the PreToolUse gate leaves the session's own tools to the tool, and a failure inside it is a deny, while the turn runs", async (t) => {
  const seen = [];
  const decisions = {};
  const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? 'none';
  // The gate is asked from inside a host tool's call: the drive is live, so a deny is the gate's own, not a stopped session's.
  const probe = { name: 'probe', description: 'Probe the gate.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => {
    const [gate] = seen[0].hooks.PreToolUse[0].hooks;
    const ask = (input) => gate({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/', ...input }, input.tool_use_id, { signal: new AbortController().signal });
    decisions.own = decision(await ask({ tool_name: 'mcp__hands__submit', tool_input: {}, tool_use_id: 'toolu_own' }));
    // A hook that throws lets the call run, so a failure inside the gate is a deny.
    const throwing = { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/', tool_input: {}, tool_use_id: 'toolu_t', get tool_name() { throw new Error('boom'); } };
    decisions.throwing = decision(await gate(throwing, 'toolu_t', { signal: new AbortController().signal }));
    return { text: 'probed' };
  } };
  const { adapter } = await claude(t, { script: ['call probe {}', 'call submit {"value":{"answer":"ok"}}'], sdk: { onQuery: (options) => seen.push(options) } });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [probe] });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'q', system: [], user: 'Go.', schema: SCHEMAS.Out, tools: ['probe'] }), { answer: 'ok' });
  const { own, throwing } = decisions;
  assert.equal(own, 'none', "a call to the session's own tool is left to the tool, which records its intent before it runs");
  assert.equal(throwing, 'deny');
});

test("a call to anything but the session's own tools is denied by the gate and never runs, whatever its name", async (t) => {
  const dir = scratch();
  const decided = [];
  const names = ['Bash', 'Write', 'Read', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'CronCreate', 'mcp__other__tool'];
  const canary = (name) => join(dir, `canary-${name}`);
  const input = (name) => (name === 'Bash' ? { command: `touch ${canary(name)}` } : name === 'Write' ? { file_path: canary(name), content: 'x' } : { file_path: canary(name), url: 'https://example.com' });
  const script = [...names.map((name) => `builtin ${name} ${JSON.stringify(input(name))}`), 'call submit {"value":{"answer":"ok"}}'];
  const { adapter } = await claude(t, { script, sdk: { onDecision: (d) => decided.push(d) } });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: 40 });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'q', system: [], user: 'Go.', schema: SCHEMAS.Out, tools: [] }), { answer: 'ok' });
  assert.deepEqual(decided.map((d) => [d.name, d.decision]), names.map((name) => [name, 'deny']));
  for (const d of decided) assert.match(d.reason, /only tools are its own/, d.name);
  for (const name of names) assert.equal(existsSync(canary(name)), false, `${name} ran`);
});

test("webSearch: the CLI is offered WebSearch alone and told so, the gate lets it through as a built-in call recorded before it runs (safe to repeat), and still denies every other", async (t) => {
  const decided = [];
  const seen = [];
  const names = ['WebSearch', 'WebFetch', 'Bash', 'Read', 'Write', 'Skill', 'Task', 'mcp__other__tool'];
  const script = [...names.map((name) => `builtin ${name} {"query":"agentrun","url":"https://example.com"}`), 'call submit {"value":{"answer":"ok"}}'];
  const { adapter } = await claude(t, { webSearch: true, script, sdk: { onDecision: (d) => decided.push(d), onQuery: (options) => seen.push(options) } });
  const store = memorySessionStore();
  const runNode = createHarnessRunner(adapter, { store, maxTurns: 40 });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'q', system: [], user: 'Go.', schema: SCHEMAS.Out, tools: [] }), { answer: 'ok' });
  assert.deepEqual(decided.map((d) => [d.name, d.decision]), names.map((name) => [name, name === 'WebSearch' ? 'allow' : 'deny']));
  const [options] = seen;
  assert.deepEqual(options.tools, ['WebSearch']);
  assert.ok(!options.disallowedTools.includes('WebSearch') && options.disallowedTools.includes('Skill'), JSON.stringify(options.disallowedTools));
  assert.match(options.systemPrompt.append, /^Your only tools are this app's \(the mcp__hands__ tools, if it has any\) and WebSearch; you have no shell, file or fetch tools/);
  // The search's intent is in the session's records before it runs, as a read: a crash cut is retried, not reported lost.
  const records = await store.read(store.keys()[0]);
  const searches = [...foldSession('s', records).effects.values()].filter((e) => e.name.startsWith('tool.Web'));
  assert.deepEqual(searches.map((e) => [e.name, e.replay]), [['tool.WebSearch', 'safe']]);
  // Off (the default), as before: not offered, off by name, and denied.
  const off = [];
  const plain = await claude(t, { script: ['builtin WebSearch {"query":"agentrun"}', 'call submit {"value":{"answer":"ok"}}'], sdk: { onDecision: (d) => off.push(d), onQuery: (o) => off.push(o) } });
  assert.deepEqual(await createHarnessRunner(plain.adapter, { store: memorySessionStore() })({ kind: 'agent', label: 'q', system: [], user: 'Go.', schema: SCHEMAS.Out, tools: [] }), { answer: 'ok' });
  assert.deepEqual(off[0].tools, []);
  assert.ok(off[0].disallowedTools.includes('WebSearch'));
  assert.equal(off.find((d) => d.name === 'WebSearch')?.decision, 'deny');
});

test("every model request reaches the host with its tokens and its price: request_end carries input, output and cache tokens, usd above 0", async (t) => {
  const { adapter } = await claude(t, { script: ['call submit {"value":{"answer":"ok"}}'] });
  const ends = [];
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), onEvent: (e) => { if (e.type === 'request_end') ends.push(e.usage); } });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'q', system: [], user: 'Go.', schema: SCHEMAS.Out, tools: [] }), { answer: 'ok' });
  assert.ok(ends.length >= 1);
  for (const u of ends) {
    assert.ok(u.input > 0 && u.output > 0, `tokens: ${JSON.stringify(u)}`);
    assert.equal(typeof u.cacheRead, 'number');
    assert.equal(typeof u.cacheWrite, 'number');
    // The scripted provider's answer carries no cost of its own, so the host's price table prices it: a price above 0,
    // marked estimated, with no tableUsd (that sits only beside a cost the response reported).
    assert.ok(u.usd > 0 && u.estimated === true && u.tableUsd === undefined, `price: ${JSON.stringify(u)}`);
  }
});

test("every session thinks: medium when its node names no level, the node's level when it does, and never off", async (t) => {
  const seen = [];
  const { adapter } = await claude(t, { script: ['call submit {"value":{"answer":"ok"}}', 'call submit {"value":{"answer":"ok"}}', 'call submit {"value":{"answer":"ok"}}'], sdk: { onQuery: (options) => seen.push([options.thinking, options.effort]) } });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore() });
  const ask = (extra) => runNode({ kind: 'agent', label: 'q', system: [], user: 'Go.', schema: SCHEMAS.Out, tools: [], ...extra });
  await ask({});
  await ask({ thinking: 'high' });
  await ask({ effort: 'minimal' });
  assert.deepEqual(seen, [[{ type: 'adaptive' }, 'medium'], [{ type: 'adaptive' }, 'high'], [{ type: 'adaptive' }, 'low']]);
  assert.deepEqual([thinkingOf({}, 'medium'), thinkingOf({ effort: 'high' }, 'medium'), thinkingOf({ thinking: 'low', effort: 'high' }, 'medium')], ['medium', 'high', 'low']);
  // A level that would turn reasoning off is refused when the adapter is made, typed.
  for (const level of ['off', 'none', 'disabled', '']) {
    assert.throws(() => claudeAgentAdapter({ model: 'm', provider: { origin: 'https://x.invalid', credential: () => 'k' }, sdk: fakeSdk(), standIn: { command: process.execPath }, thinking: level }), (e) => e instanceof ClaudeAgentThinkingOff && e.code === 'CLAUDE_AGENT_THINKING_OFF');
  }
});

test("an interrupt as a never tool's outcome is still being written: the next turn's drive folds the outcome, never takes it for abandoned (K11 through the adapter)", async (t) => {
  let charged = 0;
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never', call: async () => { charged += 1; return { text: 'paid' }; } };
  const spec = { key: 'step:k11', label: 'pay', system: [], tools: [charge], context: 'fresh' };
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
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const { adapter } = await claude(t, { script: ['call charge {"amount":5}'] });
  const session = await adapter.open(spec, { store, writer, models, signal: new AbortController().signal, onEvent: () => {} });
  await session.send('pay');
  await until(() => held, 'the charge outcome in flight');
  // The interrupt halts the drive; the harness gives a call in flight 5 s (harness.ts, `settled`), and the next turn
  // opens a new drive. The outcome is held past that grace. Today this passes on the raw writer too: the halted
  // harness's last flush writes through the same drive's queue, behind the held outcome, so it cannot finish (and the
  // next drive cannot open) before the outcome lands. The serialized writer (serial.ts, K11 in serial.test.mjs) makes
  // that ordering the writer's, not the harness's habit; this test keeps the end-to-end property.
  const next = (async () => { await session.interrupt(); await session.send('and then?'); return session.turnEnd(); })();
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  release();
  await next;
  await session.close();
  assert.equal(charged, 1, 'the charge ran once');
  const outcome = [...foldSession(spec.key, await raw.read()).effects.values()].find((e) => e.name === 'tool.charge');
  assert.equal(outcome?.status, 'completed', `the charge ran and paid, but the log says ${outcome?.status}${outcome?.error ? ` (${outcome.error.message.slice(0, 60)})` : ''}`);
});

test("a crash inside a never tool's call: the next process recovers the turn, and the call is reported, never run again", async (t) => {
  let charged = 0;
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never', call: (_args, { signal }) => { charged += 1; inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:s1', label: 'pay', system: [], tools: [charge], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const dir = scratch();

  // The first process: the call starts, then the process dies (its signal), with no outcome written.
  const first = await claude(t, { script: ['call charge {"amount":5}'], sessionsDir: dir });
  const died = new AbortController();
  const a = await first.adapter.open(spec, { store, writer: await store.open('step:s1'), models, signal: died.signal, onEvent: () => {} });
  assert.equal(a.state, 'new');
  await a.send('pay');
  await reached;
  died.abort(new Error('the process died'));
  assert.equal((await a.turnEnd()).status, 'interrupted');
  await a.close();

  // The next process: the turn is open; recovering it reports the call interrupted and does not run it again.
  const next = await claude(t, { sessionsDir: dir });
  const b = await next.adapter.open(spec, { store, writer: await store.open('step:s1'), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'open_turn');
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();
  assert.equal(charged, 1, 'the charge ran once');
  const ended = (await store.read('step:s1')).filter((r) => r.kind === 'kernel.end').map((r) => r.data);
  assert.ok(ended.some((e) => e.status === 'failed' && e.error?.interrupted === true), JSON.stringify(ended));
});

test("the same crash, the next process in a NEW session directory (a fresh box): it recovers from the session store alone", async (t) => {
  let charged = 0;
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never', call: (_args, { signal }) => { charged += 1; inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:s1', label: 'pay', system: [], tools: [charge], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const dir = scratch();

  // The first process: the call starts, then the process dies (its signal), with no outcome written.
  const first = await claude(t, { script: ['call charge {"amount":5}'], sessionsDir: dir });
  const died = new AbortController();
  const a = await first.adapter.open(spec, { store, writer: await store.open('step:s1'), models, signal: died.signal, onEvent: () => {} });
  assert.equal(a.state, 'new');
  await a.send('pay');
  await reached;
  died.abort(new Error('the process died'));
  assert.equal((await a.turnEnd()).status, 'interrupted');
  await a.close();

  // The next process: the turn is open; recovering it reports the call interrupted and does not run it again.
  // Nothing of the first process's directory survives: the session store is all the next one has.
  const next = await claude(t, { sessionsDir: scratch() });
  const b = await next.adapter.open(spec, { store, writer: await store.open('step:s1'), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'open_turn');
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();
  assert.equal(charged, 1, 'the charge ran once');
  const ended = (await store.read('step:s1')).filter((r) => r.kind === 'kernel.end').map((r) => r.data);
  assert.ok(ended.some((e) => e.status === 'failed' && e.error?.interrupted === true), JSON.stringify(ended));
});

test("a turn a halt ended with a reason (the transcript mirror's) ends failed and names it; the session's own interrupt and close end it interrupted", async (t) => {
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const halted = await claude(t, { script: ['mirror-error'] });
  const spec = { key: 'step:halt', label: 'h', system: [], tools: [], context: 'fresh' };
  const a = await halted.adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  await a.send('go');
  const end = await a.turnEnd();
  assert.equal(end.status, 'failed', JSON.stringify(end));
  assert.match(end.error ?? '', /mirror_unmapped/);
  await a.close();
  // A call that runs until it is stopped: stopped by the session itself, once by its interrupt and once by its close.
  for (const stop of ['interrupt', 'close']) {
    let inside;
    const reached = new Promise((resolve) => { inside = resolve; });
    const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
    const own = await claude(t, { script: ['call wait {}'] });
    const key = `step:${stop}`;
    const b = await own.adapter.open({ ...spec, key, tools: [wait] }, { store, writer: await store.open(key), models, signal: new AbortController().signal, onEvent: () => {} });
    await b.send('go');
    await reached;
    const ending = b.turnEnd();
    if (stop === 'interrupt') await b.interrupt(); else await b.close();
    assert.equal((await ending).status, 'interrupted', stop);
    if (stop === 'interrupt') await b.close();
  }
});

test("the adapter ends an aborted turn only through the kernel's abortedOutcome, and keeps no interrupted end of its own", () => {
  // Structural: a halt with a reason the fakes cannot raise mid-turn still ends this adapter's turn as every other's.
  const source = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
  assert.match(source, /abortedOutcome\(current\.signal, io\.signal\)/);
  assert.doesNotMatch(source, /status:\s*"interrupted"/);
});

test("a turn its session interrupted (a stop) is open to the next process; settled, it ends interrupted, sends nothing and stays ended, and the next turn carries no recovery of it", async (t) => {
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:stop', label: 'stop', system: [], tools: [wait], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const dir = scratch();
  const first = await claude(t, { script: ['call wait {}'], sessionsDir: dir });
  const a = await first.adapter.open(spec, { store, writer: await store.open('step:stop'), models, signal: new AbortController().signal, onEvent: () => {} });
  await a.send('go');
  await reached;
  const ending = a.turnEnd();
  await a.interrupt();
  assert.equal((await ending).status, 'interrupted');
  await a.close();

  const systems = [];
  const next = await claude(t, { sessionsDir: dir, sdk: { onSystem: (s) => systems.push(s) } });
  const b = await next.adapter.open(spec, { store, writer: await store.open('step:stop'), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'open_turn', 'the stopped turn is open to the next process');
  await b.settleOpenTurn();
  assert.equal(b.state, 'idle');
  await b.send('and now?');
  assert.equal((await b.turnEnd()).status, 'completed');
  assert.ok(systems.length > 0, 'the next turn sent its system prompt');
  for (const s of systems) assert.doesNotMatch(s.sent ?? '', /\[Recovery\]/, 'the next turn carries no recovery of the stopped one');
  await b.close();

  const later = await claude(t, { sessionsDir: dir });
  const c = await later.adapter.open(spec, { store, writer: await store.open('step:stop'), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(c.state, 'idle', 'settled for good: no open turn for the process after');
  await c.close();
});

test("a turn stopped before its prompt was placed: settled, its prompt stays in the conversation: a later open finds no open turn and writes no second end, and the next message's turn carries it", async (t) => {
  const spec = { key: 'step:early', label: 'early', system: [], tools: [], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const dir = scratch();
  const folded = async () => foldSession(spec.key, await store.read(spec.key));
  const openOn = async (adapter) => adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  const first = await claude(t, { sessionsDir: dir });
  const a = await openOn(first.adapter);
  await a.send('go');
  // The stop lands at once: before the harness has attached and placed the prompt.
  const ending = a.turnEnd();
  await a.interrupt();
  assert.equal((await ending).status, 'interrupted');
  await a.close();
  const stopped = await folded();
  const go = stopped.submissions.find((s) => s.text === 'go');
  assert.ok(go && !stopped.placed.has(go.id), 'setup: the stop landed before the prompt was placed');

  const seen = [];
  const next = await claude(t, { sessionsDir: dir, sdk: { onMessage: (m) => seen.push(m.text) } });
  const b = await openOn(next.adapter);
  assert.equal(b.state, 'open_turn', 'setup: the stopped turn is open to the next process');
  await b.settleOpenTurn();
  const pendingAfterSettle = pendingSubmissions(await folded()).map((s) => s.text);
  await b.close();

  // The process after it: serve's open settles a stopped turn it finds open, as here.
  const later = await claude(t, { sessionsDir: dir, sdk: { onMessage: (m) => seen.push(m.text) } });
  const c = await openOn(later.adapter);
  const laterOpen = c.state;
  if (c.state === 'open_turn') await c.settleOpenTurn();
  const ends = transcriptOf(await folded()).filter((r) => r.data?.type === 'turn').map((r) => r.data.status);
  await c.send('and now?');
  assert.equal((await c.turnEnd()).status, 'completed');
  await c.close();
  const ended = await folded();
  const placed = ended.submissions.filter((s) => ended.placed.has(s.id)).map((s) => s.text);
  assert.deepEqual(
    { pendingAfterSettle, laterOpen, ends, follows: placed.at(-1) },
    { pendingAfterSettle: [], laterOpen: 'idle', ends: ['interrupted'], follows: CARRIED },
    "the stopped turn is settled: no later open finds it open or ends it again",
  );
  // The stopped prompt stays in the conversation: the follow-up's turn carries it, and it never runs as a turn of its own.
  assert.equal(seen.length, 1, `one turn, the follow-up's: ${JSON.stringify(seen)}`);
  assert.match(seen[0], /go[\s\S]*and now\?/, "the follow-up's turn has the stopped prompt, before the follow-up");
});

test("a turn stopped before its prompt was placed, then a message in the same process: the session reads open_turn after the stop, and the message's turn carries the stopped prompt", async (t) => {
  const spec = { key: 'step:early-here', label: 'early', system: [], tools: [], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const folded = async () => foldSession(spec.key, await store.read(spec.key));
  const seen = [];
  const { adapter } = await claude(t, { sdk: { onMessage: (m) => seen.push(m.text) } });
  const a = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  await a.send('go');
  // The stop lands at once: before the harness has attached and placed the prompt.
  const ending = a.turnEnd();
  await a.interrupt();
  assert.equal((await ending).status, 'interrupted');
  const stopped = await folded();
  const go = stopped.submissions.find((s) => s.text === 'go');
  assert.ok(go && !stopped.placed.has(go.id), 'setup: the stop landed before the prompt was placed');
  // As serve's stop does: a turn the session still holds open after the interrupt is settled there.
  const afterStop = a.state;
  if (a.state === 'open_turn') await a.settleOpenTurn();
  await a.send('and now?');
  assert.equal((await a.turnEnd()).status, 'completed');
  await a.close();
  const ended = await folded();
  const placed = ended.submissions.filter((s) => ended.placed.has(s.id)).map((s) => s.text);
  assert.deepEqual(
    { afterStop, pending: pendingSubmissions(ended).map((s) => s.text), follows: placed.at(-1) },
    { afterStop: 'open_turn', pending: [], follows: CARRIED },
    'the stop leaves the turn open to settle, and nothing is left pending',
  );
  // The stopped prompt stays in the conversation: the follow-up's turn carries it, and it never runs as a turn of its own.
  assert.equal(seen.length, 1, `one turn, the follow-up's: ${JSON.stringify(seen)}`);
  assert.match(seen[0], /go[\s\S]*and now\?/, "the follow-up's turn has the stopped prompt, before the follow-up");
});

test("a runner's pause before the node's prompt was placed: the next process resumes the node with its own prompt, not the nudge", async (t) => {
  const store = memorySessionStore();
  const request = { kind: 'agent', label: 'q', system: [], user: 'The node asks this.', schema: SCHEMAS.Out, tools: [], step: { sessionId: 'paused', attempt: 0, earlierSessionIds: [] } };
  // The first process pauses its runner the moment the node's prompt is in the session, before the harness places it.
  const first = await claude(t);
  let runner;
  const pausing = { ...first.adapter, open: async (...args) => {
    const session = await first.adapter.open(...args);
    return Object.create(session, { send: { value: async (text) => { await session.send(text); await runner.stop({ drainMs: 0 }); } } });
  } };
  runner = createHarnessRunner(pausing, { store });
  await assert.rejects(runner({ ...request }), (error) => error.reason === 'aborted');
  const key = 'step:paused';
  const paused = foldSession(key, await store.read(key));
  assert.deepEqual(pendingSubmissions(paused).map((s) => s.text), [request.user], "setup: the node's prompt is in the session, unplaced");

  const seen = [];
  const next = await claude(t, { script: ['call submit {"value":{"answer":"resumed"}}'], sdk: { onMessage: (m) => seen.push(m.text) } });
  assert.deepEqual(await createHarnessRunner(next.adapter, { store })({ ...request }), { answer: 'resumed' });
  assert.equal(seen[0], request.user, "the paused node resumes with its own prompt");
});

test("an interrupt that lands while send() is still recording the prompt: the session reads open_turn after the stopped turn, and the next message's turn carries the stopped prompt", async (t) => {
  const spec = { key: 'step:abort-submit', label: 'abort', system: [], tools: [], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const folded = async () => foldSession(spec.key, await store.read(spec.key));
  // The session's writer, with the prompt's submission held at its append until the test lets it go.
  const inner = await store.open(spec.key);
  let held;
  const reached = new Promise((resolve) => { held = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => {
    if (records.some((r) => r.kind === 'kernel.submission' && r.data?.text === 'go')) { held(); await gate; }
    return inner.append(records);
  } };
  const seen = [];
  const { adapter } = await claude(t, { sdk: { onMessage: (m) => seen.push(m.text) } });
  const a = await adapter.open(spec, { store, writer, models, signal: new AbortController().signal, onEvent: () => {} });
  const sending = a.send('go');
  await reached;
  // The stop lands while the prompt is being recorded: no turn is running yet.
  await a.interrupt();
  release();
  await sending;
  assert.equal((await a.turnEnd()).status, 'interrupted');
  const stopped = await folded();
  const go = stopped.submissions.find((s) => s.text === 'go');
  assert.ok(go && !stopped.placed.has(go.id), 'setup: the stopped prompt was recorded and never placed');
  // As serve's stop does: a turn the session still holds open after the stop is settled.
  const afterStop = a.state;
  if (a.state === 'open_turn') await a.settleOpenTurn();
  await a.send('and now?');
  assert.equal((await a.turnEnd()).status, 'completed');
  await a.close();
  const ended = await folded();
  const placed = ended.submissions.filter((s) => ended.placed.has(s.id)).map((s) => s.text);
  assert.deepEqual(
    { afterStop, pending: pendingSubmissions(ended).map((s) => s.text), follows: placed.at(-1) },
    { afterStop: 'open_turn', pending: [], follows: CARRIED },
    'the stop leaves the turn open to settle, and nothing is left pending',
  );
  // The stopped prompt stays in the conversation: the follow-up's turn carries it, and it never runs as a turn of its own.
  assert.equal(seen.length, 1, `one turn, the follow-up's: ${JSON.stringify(seen)}`);
  assert.match(seen[0], /go[\s\S]*and now\?/, "the follow-up's turn has the stopped prompt, before the follow-up");
});

/** The session's writer, held at the first append `match` picks (it gets each record and the prompts' submission ids by
 *  their text) until the test lets it go. */
function holdingWriter(inner, match) {
  const ids = new Map();
  let held;
  const reached = new Promise((resolve) => { held = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let done = false;
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => {
    for (const r of records) if (r.kind === 'kernel.submission' && typeof r.data?.text === 'string') ids.set(r.data.text, r.data.id);
    if (!done && records.some((r) => match(r, ids))) { done = true; held(); await gate; }
    return inner.append(records);
  } };
  return { writer, reached, release };
}
/** The intent of the placement of the prompt that says `text`. */
const placing = (text) => (r, ids) => r.kind === 'kernel.start' && Array.isArray(r.data?.placed) && r.data.placed.includes(ids.get(text));
/** The intent of a prompt's send mark. */
const marking = (r) => r.kind === 'kernel.start' && String(r.data?.key ?? '').startsWith('sent:');

/** QA's walk of F1 on claude-agent: the person's message, stopped the instant it is sent, then "Go on.". */
const CODE_ASK = 'Reply with exactly this code and nothing else: CARRY-CLAUDE-7';

test("F1, the walk on claude-agent: \"Reply with exactly this code and nothing else: CARRY-CLAUDE-7\", stopped the instant it is sent (placed, before the CLI was handed it), then \"Go on.\": the session reads open_turn, its settle withdraws the placed prompt with its carry, and Go on.'s turn has the code's ask first", async (t) => {
  const spec = { key: 'claude:placed-unsent', label: 'placed', system: [], tools: [], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const { writer, reached, release } = holdingWriter(await store.open(spec.key), placing(CODE_ASK));
  const seen = [];
  const { adapter: claudeAdapter } = await claude(t, { sdk: { onMessage: (m) => seen.push(m.text) } });
  const a = await claudeAdapter.open(spec, { store, writer, models, signal: new AbortController().signal, onEvent: () => {} });
  await a.send(CODE_ASK);
  await reached;
  // The stop lands while the prompt's placement is being written (Claude places within its first second): once placed,
  // the CLI is never handed it.
  const stopping = a.interrupt();
  release();
  await stopping;
  assert.equal((await a.turnEnd()).status, 'interrupted');
  const stopped = foldSession(spec.key, await store.read(spec.key));
  const ask = stopped.submissions.find((s) => s.text === CODE_ASK);
  assert.ok(ask && stopped.placed.has(ask.id), 'setup: the stopped prompt was placed');
  const afterStop = a.state;
  if (a.state === 'open_turn') await a.settleOpenTurn();
  await a.send('Go on.');
  assert.equal((await a.turnEnd()).status, 'completed');
  await a.close();
  const ended = foldSession(spec.key, await store.read(spec.key));
  const withdraws = ended.submissions.filter((s) => s.kind === 'withdraw' && s.target === ask.id).map((s) => ({ carry: s.carry, unsent: s.unsent }));
  assert.deepEqual(
    { afterStop, withdraws, follows: ended.submissions.filter((s) => ended.placed.has(s.id)).map((s) => s.text).at(-1) },
    { afterStop: 'open_turn', withdraws: [{ carry: true, unsent: true }], follows: `${CODE_ASK}\n\n(The message above was stopped before any work on it began.)\n\nGo on.` },
    "the placed prompt the CLI was never handed is withdrawn with its carry, and Go on. carries it",
  );
  assert.equal(seen.length, 1, `one turn, Go on.'s: ${JSON.stringify(seen)}`);
  assert.match(seen[0], /CARRY-CLAUDE-7[\s\S]*stopped before any work[\s\S]*Go on\./, "Go on.'s turn has the code's ask, then the stopped line, then Go on.");
});

test("an interrupt that lands after the CLI recorded the prompt (mid-turn, in a tool call): its transcript holds the prompt, so the settle carries nothing and the next message's turn is its own", async (t) => {
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'claude:recorded', label: 'recorded', system: [], tools: [wait], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const seen = [];
  const { adapter: claudeAdapter } = await claude(t, { script: ['call wait {}'], sdk: { onMessage: (m) => seen.push(m.text) } });
  const a = await claudeAdapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  await a.send('go');
  await reached;
  // The CLI's transcript lines reach the session's log once their coalesce window (150 ms) has passed.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await a.interrupt();
  await a.turnEnd();
  if (a.state === 'open_turn') await a.settleOpenTurn();
  await a.send('and now?');
  await a.turnEnd();
  await a.close();
  const ended = foldSession(spec.key, await store.read(spec.key));
  const placed = ended.submissions.filter((s) => ended.placed.has(s.id)).map((s) => s.text);
  assert.deepEqual({ follows: placed.at(-1), seen }, { follows: 'and now?', seen: ['go', 'and now?'] }, 'a prompt the CLI recorded is not carried: it is never sent twice');
});

test("a follow-up's own prompt the host names to the settle (`opening`) is withdrawn and never carried: the next message's turn is the person's alone", async (t) => {
  const spec = { key: 'claude:host-follow-up', label: 'host', system: [], tools: [], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const own = 'follow-up:claude:host-follow-up:follow-up:check';
  // The follow-up's prompt was recorded, and its process died before the harness took it.
  const drive = await openDrive({ writer: await store.open(spec.key), signal: new AbortController().signal });
  await drive.submit({ id: own, kind: 'prompt', text: 'Summarize the run.' });
  const seen = [];
  const { adapter: claudeAdapter } = await claude(t, { sdk: { onMessage: (m) => seen.push(m.text) } });
  const a = await claudeAdapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(a.state, 'open_turn', "setup: the follow-up's turn is open");
  await a.settleOpenTurn({ opening: own });
  await a.send('and now?');
  assert.equal((await a.turnEnd()).status, 'completed');
  await a.close();
  const modelSaw = seen;
  assert.deepEqual(modelSaw.map((text) => [/Summarize the run/.test(text), /and now\?/.test(text)]), [[false, true]], `the person's message alone: ${JSON.stringify(modelSaw)}`);
});

// The settle decides a placed prompt's carry by the CLI's transcript as the session's log keeps it. A resumed CLI is
// given that same log, so the two must agree: a prompt is carried exactly when the history the next CLI restores lacks
// it. The case that could break it is a stop while the CLI's transcript lines are still in their coalesce window (not
// yet in the log): if anything wrote them after the settle read the log, the prompt would be carried AND in the history,
// sent twice. A stopped drive writes nothing more, so it never happens.
test("a stop while the CLI's transcript lines are still in their coalesce window, and one after they reached the log: the settle carries the prompt exactly when the history the next CLI restores lacks it, so the model has it once, never twice and never none", async (t) => {
  const { JournalSessionStore } = await import('../dist/store.js');
  const { uuidFrom } = await import('../dist/ids.js');
  const { NativeJournal } = await import('@parcha/agentrun-kernel/process');
  const outcomes = [];
  for (const [label, settleMs] of [['in the window', 0], ['after it', 500]]) {
    let inside;
    const reached = new Promise((resolve) => { inside = resolve; });
    const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
    const spec = { key: `claude:flush-${settleMs}`, label: 'flush', system: [], tools: [wait], context: 'fresh' };
    const store = memorySessionStore();
    const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
    const { adapter: claudeAdapter } = await claude(t, { script: ['call wait {}'] });
    const a = await claudeAdapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
    await a.send('go');
    await reached;
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    await a.interrupt();
    await a.turnEnd();
    if (a.state === 'open_turn') await a.settleOpenTurn();
    await a.close();
    // What the next drive restores: the session's log, read as the harness reads it at a drive's start.
    const drive = await openDrive({ writer: await store.open(spec.key), signal: new AbortController().signal });
    const state = drive.state();
    const go = state.submissions.find((s) => s.text === 'go');
    const history = new JournalSessionStore(new NativeJournal(drive), { records: await new NativeJournal(drive).read() });
    const recorded = history.hasUser(uuidFrom(go.id));
    const carried = state.submissions.some((s) => s.kind === 'withdraw' && s.target === go.id && s.carry);
    outcomes.push({ label, recorded, carried });
  }
  assert.deepEqual(outcomes.map((o) => o.carried !== o.recorded), [true, true], `carried exactly when the next history lacks it: ${JSON.stringify(outcomes)}`);
  assert.deepEqual(outcomes[1], { label: 'after it', recorded: true, carried: false }, 'once the lines are in the log, nothing is carried');
});

test("a prompt a crash left placed and unrecorded, sent again in the recovery message, then a stop after the CLI recorded that message: the settle does not carry it a second time, and the next message's turn is its own", async (t) => {
  const { placeSubmissions } = await import('@parcha/agentrun-kernel/process');
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'claude:recovered', label: 'recovered', system: [], tools: [wait], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  // The crashed process: the prompt placed, the CLI never told.
  const dead = await openDrive({ writer: await store.open(spec.key), signal: new AbortController().signal });
  await dead.submit({ id: 's1', kind: 'prompt', text: 'Write five files.' });
  await placeSubmissions(dead, dead.pending());
  const seen = [];
  const { adapter: claudeAdapter } = await claude(t, { script: ['call wait {}'], sdk: { onMessage: (m) => seen.push(m.text) } });
  const a = await claudeAdapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(a.state, 'open_turn', 'setup: the crashed turn is open');
  await a.recover();
  await reached;
  // The recovery message is in the CLI's transcript, as the session keeps it, once its coalesce window has passed.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await a.interrupt();
  await a.turnEnd();
  if (a.state === 'open_turn') await a.settleOpenTurn();
  await a.send('and now?');
  await a.turnEnd();
  await a.close();
  assert.equal(seen.length, 2, `the recovery message, then the next one: ${JSON.stringify(seen)}`);
  assert.match(seen[0], /Write five files\./, 'setup: the recovery message carried the prompt');
  assert.equal(seen[1], 'and now?', 'the next message is its own: the prompt is not sent a second time');
});

test("a second crash in the same open turn: recovery 1 handed over and never recorded, then recovery 2 recorded, then a stop: the settle does not carry the prompt again, and the next message's turn is its own", async (t) => {
  const { placeSubmissions } = await import('@parcha/agentrun-kernel/process');
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'claude:recovered-twice', label: 'recovered', system: [], tools: [wait], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  // The first crash: the prompt placed, the CLI never told. The second: recovery 1 covered it and was never recorded.
  const dead = await openDrive({ writer: await store.open(spec.key), signal: new AbortController().signal });
  await dead.submit({ id: 's1', kind: 'prompt', text: 'Write five files.' });
  await placeSubmissions(dead, dead.pending());
  await dead.effect('covers:00000000-0000-4000-8000-000000000001', { name: 'covers', replay: 'safe', input: { ids: ['s1'] } }, async () => true);
  const seen = [];
  const { adapter: claudeAdapter } = await claude(t, { script: ['call wait {}'], sdk: { onMessage: (m) => seen.push(m.text) } });
  const a = await claudeAdapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  await a.recover();
  await reached;
  await new Promise((resolve) => setTimeout(resolve, 500));
  await a.interrupt();
  await a.turnEnd();
  if (a.state === 'open_turn') await a.settleOpenTurn();
  await a.send('and now?');
  await a.turnEnd();
  await a.close();
  assert.match(seen[0] ?? '', /Write five files\./, 'setup: recovery 2 carried the prompt');
  assert.equal(seen.at(-1), 'and now?', `the next message is its own: ${JSON.stringify(seen)}`);
});
