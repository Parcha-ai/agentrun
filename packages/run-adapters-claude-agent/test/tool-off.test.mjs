// The pinned Claude Agent CLI, through the adapter and the real Agent SDK, with a scripted model behind the session's
// proxy that tries every way to run something of the CLI's own: its built-in tools, a sub-agent, the web, a scheduled
// job, another MCP server's tool. Nothing may run, write or fetch; the only tools that run are the host's. Every route
// the CLI calls is recorded: one the proxy's table lacks fails the test, so a CLI bump that adds an endpoint is caught.
// No network: the provider is a scripted Anthropic API on the loopback interface.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing or different one fails.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { CLAUDE_AGENT_ALSO_OFF, CLAUDE_AGENT_SDK_VERSION, claudeAgentAdapter, claudeAgentExecutable, verifyClaudeAgent } from '@parcha/agentrun-claude-agent';
import { CLAUDE_BUILTINS, CLAUDE_BUILTINS_OFF } from '../dist/harness.js';
import { fakeAnthropic } from '@parcha/agentrun-claude-agent/testing';
import { CLAUDE_BETAS, CLAUDE_BLOCKS, CLAUDE_MESSAGES_ROUTES } from '../dist/host/policy.js';

/** Every content block type in a request's messages and system prompt, and inside its tool results. */
function blockTypes(body) {
  const out = [];
  const walk = (content) => {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      out.push(b?.type);
      if (b?.type === 'tool_result') walk(b.content);
    }
  };
  walk(body?.system);
  for (const m of body?.messages ?? []) walk(m.content);
  return out;
}

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-off-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('the pinned Claude Agent SDK and CLI are present where they are required', { skip: !required && 'not required here' }, () => {
  assert.equal(problem, undefined, problem);
});

/** The tools the pinned CLI (2.1.286) has with its whole preset, as its system/init message lists them. */
const PINNED_CLI_TOOLS = ['Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterWorktree', 'ExitWorktree', 'ListAgents', 'NotebookEdit', 'Read', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'Task', 'TaskStop', 'WebFetch', 'WebSearch', 'Workflow', 'Write'];

test("the pinned CLI's tool set is the one the harness's lists decide: each of its tools is allowlisted or off, and the allowlist names only tools it has", { skip, timeout: 60_000 }, async (t) => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const home = mkdtempSync(join(ROOT, 'preset-'));
  const abortController = new AbortController();
  let tools;
  // The whole preset, read from the CLI's system/init (sent before any model request), then stopped.
  const q = sdk.query({ prompt: 'hi', options: {
    pathToClaudeCodeExecutable: claudeAgentExecutable(), cwd: home, settingSources: [], abortController,
    env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: join(home, 'config'), ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: 'probe', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  } });
  for await (const m of q) if (m.type === 'system' && m.subtype === 'init') { tools = [...m.tools].sort(); break; }
  abortController.abort();
  // A CLI whose tools differ (a new one, or one gone) is caught here, before it is trusted.
  assert.deepEqual(tools, PINNED_CLI_TOOLS);
  const decided = new Set([...CLAUDE_BUILTINS, ...CLAUDE_BUILTINS_OFF, ...CLAUDE_AGENT_ALSO_OFF]);
  for (const tool of tools) assert.ok(decided.has(tool), `${tool} is neither allowlisted nor off`);
  for (const tool of CLAUDE_BUILTINS) assert.ok(tools.includes(tool), `the allowlist names ${tool}, which this CLI does not have`);
});

const MODEL = 'claude-sonnet-5-5';
const SMALL = 'claude-haiku-4-5';

test("the CLI's every built-in, the web, a sub-agent and another MCP server are unavailable; only the host's tools run", { skip, timeout: 240_000 }, async (t) => {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const canary = (name) => join(dir, `canary-${name}`);
  // What the model asks for, one call per main-model request, then the host's tools, then plain text.
  const attacks = [
    ['Bash', { command: `touch ${canary('bash')}`, description: 'x' }],
    ['Bash', { command: `touch ${canary('bg')}`, run_in_background: true, description: 'x' }],
    ['Write', { file_path: canary('write'), content: 'pwned' }],
    ['Edit', { file_path: canary('edit'), old_string: 'a', new_string: 'b' }],
    ['Read', { file_path: '/etc/hostname' }],
    ['Glob', { pattern: '**/*' }],
    ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
    ['WebSearch', { query: 'x' }],
    ['Task', { description: 'x', prompt: `touch ${canary('task')}`, subagent_type: 'general-purpose' }],
    ['Agent', { description: 'x', prompt: `touch ${canary('agent')}`, subagent_type: 'general-purpose' }],
    ['NotebookEdit', { notebook_path: canary('nb'), new_source: 'x' }],
    ['CronCreate', { schedule: '* * * * *', prompt: `touch ${canary('cron')}` }],
    ['Skill', { skill: 'x' }],
    ['mcp__other__exec', { command: `touch ${canary('mcp')}` }],
  ];
  // The model thinks before each call, as a thinking model answers, so the CLI sends its thinking back.
  const plan = [...attacks.map(([name, input]) => ({ tool: { name, input } })), { tool: { name: 'mcp__hands__lookup', input: { q: 'x' } } }, { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } }].map((r, i) => ({ ...r, thinking: `step ${i}`, ...(i % 2 ? { redacted: 'cmVkYWN0ZWQ=' } : {}) }));
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());

  const logged = [];
  const real = await import('@anthropic-ai/claude-agent-sdk');
  let asked;
  const sdk = { ...real, query: (args) => { asked = args.options; return real.query(args); } };
  const adapter = claudeAgentAdapter({
    sdk,
    sdkVersion: CLAUDE_AGENT_SDK_VERSION,
    model: MODEL,
    smallModel: SMALL,
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    sessionsDir: join(dir, 'sessions'),
    log: (message, detail) => logged.push({ message, ...detail }),
  });
  const ran = [];
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async (args) => { ran.push(args); return { text: 'found' }; } };
  const toolEvents = [];
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup], maxTurns: 60, timeoutMs: 200_000, onEvent: (e) => { if (e.type === 'tool_start' || e.type === 'tool_end') toolEvents.push(e); } });
  const output = await runNode({ kind: 'agent', label: 'probe', system: ['Answer.'], user: 'Say ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['lookup'] });

  assert.deepEqual(output, { answer: 'ok' });
  assert.deepEqual(ran, [{ q: 'x' }]);
  // Only the host's tools ran; every other call the model made is shown to the host as a call that failed, by its name.
  assert.deepEqual(toolEvents.filter((e) => e.type === 'tool_end' && !e.isError).map((e) => e.name), ['lookup', 'submit']);
  for (const [name] of attacks) assert.ok(toolEvents.some((e) => e.type === 'tool_end' && e.name === name && e.isError), `${name} is shown as a failed call`);
  assert.equal(main >= plan.length, true, `the model got to ask for everything (${main} of ${plan.length})`);
  for (const [name] of attacks) assert.equal(existsSync(canary(name.toLowerCase())), false, `${name} wrote`);
  for (const name of ['bash', 'bg', 'write', 'edit', 'task', 'agent', 'nb', 'cron', 'mcp']) assert.equal(existsSync(canary(name)), false, name);
  const sessions = join(dir, 'sessions');
  for (const session of readdirSync(sessions)) assert.deepEqual(readdirSync(join(sessions, session, 'work')), [], "the session's working directory stays empty");

  // Every request the CLI made was one the table holds: the proxy refused nothing (a route the table lacks would be
  // refused and reported, so nothing was quietly missing), and everything it forwarded is in the table. What reached
  // the scripted provider without the provider's key did not come through the proxy (the provider listens on a
  // loopback port of a shared machine, which another local process may knock on): it is reported, not judged.
  const table = new Set(CLAUDE_MESSAGES_ROUTES.map((r) => `${r.method} ${r.path}`));
  const forwarded = provider.requests.filter((r) => r.authorized);
  const strays = provider.requests.filter((r) => !r.authorized);
  if (strays.length) t.diagnostic(`not through the proxy (ignored): ${strays.map((r) => `${r.method} ${r.path}`).join(', ')}`);
  const routes = new Set(forwarded.map((r) => `${r.method} ${r.path}${r.query ? `?${r.query}` : ''}`));
  for (const r of forwarded) {
    assert.ok(table.has(`${r.method} ${r.path}`), `${r.method} ${r.path} is not in the table`);
    assert.ok(r.query === '' || CLAUDE_MESSAGES_ROUTES.find((x) => x.path === r.path)?.query?.includes(r.query), `query ${r.query} on ${r.path}`);
  }
  assert.deepEqual(logged.filter((l) => /refused/.test(l.message)), [], 'the proxy refused nothing the CLI asked');
  // Even with its built-ins on, a session could not reach a tool of this CLI's that the allowlist does not name.
  assert.deepEqual(asked.tools, []);
  for (const tool of PINNED_CLI_TOOLS.filter((t) => !CLAUDE_BUILTINS.includes(t))) assert.ok(asked.disallowedTools.includes(tool), `${tool} is not off by name`);
  // The model is offered the host's tools only.
  for (const r of provider.messages()) for (const name of r.tools) assert.match(name, /^mcp__hands__(lookup|submit)$/, `the model was offered ${name}`);
  // The betas the pinned CLI sends: each one the policy knows.
  const betas = new Set(forwarded.flatMap((r) => (r.headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean)));
  for (const b of betas) assert.ok(CLAUDE_BETAS.has(b), `the CLI sent the beta ${b}`);
  // Every main-model request thinks: the session's level (medium, as no node level was named) is on the wire, as
  // adaptive thinking or an effort. The small model's background calls (titles, summaries) are exempt.
  const mainCalls = forwarded.filter((r) => r.path === '/v1/messages' && r.model === MODEL);
  assert.ok(mainCalls.length >= plan.length);
  for (const r of mainCalls) {
    const thinking = r.body.thinking;
    const effort = r.body.output_config?.effort;
    assert.ok(thinking?.type === 'adaptive' || thinking?.type === 'enabled' || typeof effort === 'string', `a main-model request without thinking: ${JSON.stringify({ thinking, effort })}`);
    if (effort !== undefined) assert.equal(effort, 'medium');
  }
  assert.deepEqual(logged.filter((l) => /thinking\.disabled/.test(l.message)), [], 'the proxy saw no main-model request without thinking');
  const small = forwarded.filter((r) => r.path === '/v1/messages' && r.model === SMALL);
  t.diagnostic(`thinking on the wire: ${JSON.stringify([...new Set(mainCalls.map((r) => JSON.stringify({ thinking: r.body.thinking, effort: r.body.output_config?.effort })))])}; small-model calls (exempt): ${small.length}`);
  t.diagnostic(`routes: ${[...routes].sort().join(' | ')}`);
  t.diagnostic(`betas: ${[...betas].sort().join(', ')}`);
  // The content blocks the CLI sent: every one a type the policy allows (the proxy refused nothing, above).
  const types = new Set(forwarded.flatMap((r) => blockTypes(r.body)));
  for (const type of types) assert.ok(CLAUDE_BLOCKS.has(type), `the CLI sent a ${type} block`);
  t.diagnostic(`blocks: ${[...types].sort().join(', ')}`);
  t.diagnostic(`requests: ${forwarded.length}, main-model: ${main}, sdk ${CLAUDE_AGENT_SDK_VERSION}`);
  assert.ok(forwarded.length >= plan.length, 'every model request came through the proxy, with the provider key');
});

/** One node through the adapter on the pinned CLI, `model` its main model, `extra` the node's own fields: what reached
 *  the scripted provider through the proxy, and what the adapter logged. */
async function oneNode(t, model, extra = {}) {
  const dir = mkdtempSync(join(ROOT, 'wire-'));
  let asked = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === model && asked++ === 0 ? { thinking: 'plan', redacted: 'cmVkYWN0ZWQ=', tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } } : { text: 'done' }) });
  t.after(() => provider.close());
  const logged = [];
  const adapter = claudeAgentAdapter({
    model,
    smallModel: SMALL,
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    sessionsDir: join(dir, 'sessions'),
    log: (message, detail) => logged.push({ message, ...detail }),
  });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: 10, timeoutMs: 100_000 });
  const output = await runNode({ kind: 'agent', label: 'wire', system: ['Answer.'], user: 'Say ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [], ...extra });
  assert.deepEqual(output, { answer: 'ok' });
  const forwarded = provider.requests.filter((r) => r.authorized);
  const main = forwarded.filter((r) => r.path === '/v1/messages' && r.model === model);
  assert.ok(main.length >= 1, `${model}: no main-model request`);
  assert.deepEqual(logged.filter((l) => /refused|thinking\.disabled/.test(l.message)), [], `${model}: the proxy refused nothing and saw no request without thinking`);
  const betas = forwarded.flatMap((r) => (r.headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean));
  return { main, betas, blocks: forwarded.flatMap((r) => blockTypes(r.body)), efforts: [...new Set(main.map((r) => r.body.output_config?.effort))] };
}

// The models a host runs now. The CLI's betas and its thinking depend on the model: a model it sends a beta for that the
// allowlist lacks would be refused, so each is run here. On each, a node that names no level thinks at medium, on the
// wire; claude-haiku-5-5's own default is high, so the adapter's default is what puts medium there.
const CURRENT_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];

test("on each current model, a node that names no level thinks at medium on the wire, a node's own level reaches it, and the betas and content blocks the CLI sends are the allowlists", { skip, timeout: 240_000 }, async (t) => {
  const seen = new Set();
  const sent = new Set();
  for (const model of CURRENT_MODELS) {
    const { main, betas, blocks, efforts } = await oneNode(t, model);
    for (const type of blocks) sent.add(type);
    for (const b of betas) { assert.ok(CLAUDE_BETAS.has(b), `${model}: the CLI sent the beta ${b}`); seen.add(b); }
    for (const r of main) assert.equal(r.body.thinking?.type, 'adaptive', `${model}: ${JSON.stringify(r.body.thinking)}`);
    assert.deepEqual(efforts, ['medium'], model);
    t.diagnostic(`${model}: ${main.length} main-model requests, betas ${[...new Set(betas)].sort().join(',')}`);
  }
  const high = await oneNode(t, 'claude-sonnet-5-5', { thinking: 'high' });
  assert.deepEqual(high.efforts, ['high'], "the node's level");
  // The allowlists are what these models were recorded sending, no more: a value only guessed at is not in them.
  assert.deepEqual([...seen].sort(), [...CLAUDE_BETAS].sort());
  assert.deepEqual([...sent].sort(), [...CLAUDE_BLOCKS].sort(), 'the content blocks the CLI sent');
  t.diagnostic(`blocks: ${[...sent].sort().join(', ')}`);
});

/** A request's messages without the prompt-cache markers the CLI moves to the newest message each turn, and with a
 *  message's content as blocks: a resumed CLI sends a mid-conversation system note as a string where the live one sent
 *  the same text as one text block (the API takes both alike). Nothing else is normalized. */
const uncached = (messages) => JSON.parse(JSON.stringify(messages, (k, v) => (k === 'cache_control' ? undefined : v))).map?.((m) => (m && typeof m.content === 'string' && m.role === 'system' ? { ...m, content: [{ type: 'text', text: m.content }] } : m)) ?? messages;

test('the real CLI, killed in turn 2, resumes in a NEW session directory from the session store alone: turn 3 runs on the same history, nothing re-sent', { skip, timeout: 240_000 }, async (t) => {
  const model = 'claude-sonnet-5-5';
  let main = 0;
  // Turn 1 asks for a safe tool, turn 2 for a never one (which the kill cuts off), turn 3 answers.
  const provider = await fakeAnthropic({ reply: (r) => {
    if (r.model !== model) return { text: 'ok' };
    main += 1;
    if (main === 1) return { tool: { name: 'mcp__hands__lookup', input: { q: 'x' } } };
    if (main === 2) return { tool: { name: 'mcp__hands__charge', input: { amount: 5 } } };
    return { text: 'done' };
  } });
  t.after(() => provider.close());
  const looked = [];
  let charged = 0;
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async (args) => { looked.push(args); return { text: 'found' }; } };
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: (_args, { signal }) => { charged += 1; inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:resume', label: 'pay', system: ['Use the tools.'], tools: [lookup, charge], context: 'fresh' };
  const store = memorySessionStore();
  const paid = { before: 0, after: 0 };
  const models = { beforeRequest: async () => { paid.before += 1; }, afterRequest: async () => { paid.after += 1; } };
  const adapterIn = (dir) => claudeAgentAdapter({ model, smallModel: SMALL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: dir });

  // The first process: turns 1 and 2; the drive dies inside the never call, and its CLI is killed with it.
  const firstDir = mkdtempSync(join(ROOT, 'resume-a-'));
  const died = new AbortController();
  const a = await adapterIn(firstDir).open(spec, { store, writer: await store.open(spec.key), models, signal: died.signal, onEvent: () => {} });
  assert.equal(a.state, 'new');
  await a.send('Charge the card after looking it up.');
  await reached;
  died.abort(new Error('the process died'));
  assert.equal((await a.turnEnd()).status, 'interrupted');
  await a.close();
  const sentBefore = provider.messages().filter((r) => r.model === model);
  assert.equal(sentBefore.length, 2, 'turns 1 and 2 reached the provider');

  // The next process, in a NEW directory: nothing of the first one's survives, only the session store.
  const nextDir = mkdtempSync(join(ROOT, 'resume-b-'));
  const b = await adapterIn(nextDir).open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'open_turn', 'the store holds the open turn');
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();

  const sent = provider.messages().filter((r) => r.model === model).map((r) => r.body);
  assert.equal(sent.length, 3, `three main-model requests in all, none re-sent (got ${sent.length})`);
  assert.equal(charged, 1, 'the never call ran once');
  assert.deepEqual(looked, [{ q: 'x' }], 'the safe call ran once (its result came from the store)');
  // Turn 3 carries the history of turns 1 and 2 as they were sent, then turn 2's call and its interrupted result.
  const [, second, third] = sent.map((body) => uncached(body.messages));
  assert.deepEqual(third.slice(0, second.length), second, 'turn 3 starts with the history turn 2 sent');
  const after = third.slice(second.length);
  assert.ok(after.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('mcp__hands__charge')), "turn 2's call is in the history");
  assert.ok(after.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('tool_result') && /interrupted|may or may not/.test(JSON.stringify(m.content))), "the call is answered as interrupted");
  const sameSystem = JSON.stringify(uncached(sent[2].system ?? null)) === JSON.stringify(uncached(sent[1].system ?? null));
  t.diagnostic(`turn 3 sent ${third.length} messages (turn 2: ${second.length}); system prompt the same as turn 2's: ${sameSystem}; paid hooks before ${paid.before}, after ${paid.after}`);
});

test("a host's gateway headers (its spend tags) reach the provider on every request the real CLI makes through the proxy (the proxy test covers every route, a free one too)", { skip, timeout: 120_000 }, async (t) => {
  const tags = 'job:j-123,purpose:research,run:r-9';
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL && !Object.keys(r.results ?? {}).length ? { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } } : { text: 'done' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ model: MODEL, smallModel: SMALL, provider: { origin: provider.url, credential: () => 'provider-secret', headers: { 'x-litellm-tags': tags } }, sessionsDir: join(mkdtempSync(join(ROOT, 'tags-')), 'sessions') });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: 10, timeoutMs: 100_000 });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'tags', system: ['Answer.'], user: 'Say ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] }), { answer: 'ok' });
  const reached = provider.requests.filter((r) => r.authorized);
  assert.ok(reached.some((r) => r.model === MODEL), 'a main-model request reached the provider');
  for (const r of reached) assert.equal(r.headers['x-litellm-tags'], tags, `${r.path} (${r.model}) carries the host's tags`);
  t.diagnostic(`requests with the tags: ${reached.length} (${[...new Set(reached.map((r) => `${r.path} ${r.model}`))].join('; ')})`);
});
