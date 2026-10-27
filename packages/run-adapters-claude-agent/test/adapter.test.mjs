// The Claude Agent adapter behind createHarnessRunner, as a DSL host runs it, on the scripted Agent SDK (./testing): its
// "CLI" child makes each model request through the session's real proxy to a scripted Anthropic API. No key, no network,
// no Claude Agent CLI.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createHarnessRunner, RUNNER_RECORDS } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-claude-agent';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-claude-agent/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
const doc = (root) => ({ v: 2, name: 'claude', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root });
const agent = (extra = {}) => ({ node: 'agent', label: 'task', instructions: 'Answer.', out: 'Out', as: 'final', ...extra });

/** A Claude Agent adapter on the scripted SDK, whose "model" is a scripted Anthropic API behind the session's proxy. */
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
