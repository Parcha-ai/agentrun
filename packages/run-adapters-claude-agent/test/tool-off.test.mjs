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
import { CLAUDE_AGENT_SDK_VERSION, claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-claude-agent';
import { fakeAnthropic } from '@parcha/agentrun-claude-agent/testing';
import { CLAUDE_BETAS, CLAUDE_MESSAGES_ROUTES } from '../dist/host/policy.js';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-off-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('the pinned Claude Agent SDK and CLI are present where they are required', { skip: !required && 'not required here' }, () => {
  assert.equal(problem, undefined, problem);
});

const MODEL = 'claude-sonnet-4-5';
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
  const plan = [...attacks.map(([name, input]) => ({ tool: { name, input } })), { tool: { name: 'mcp__hands__lookup', input: { q: 'x' } } }, { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } }];
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());

  const logged = [];
  const adapter = claudeAgentAdapter({
    model: MODEL,
    smallModel: SMALL,
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    sessionsDir: join(dir, 'sessions'),
    log: (message, detail) => logged.push({ message, ...detail }),
  });
  const ran = [];
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async (args) => { ran.push(args); return { text: 'found' }; } };
  const started = [];
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup], maxTurns: 60, timeoutMs: 200_000, onEvent: (e) => { if (e.type === 'tool_start') started.push(e.name); } });
  const output = await runNode({ kind: 'agent', label: 'probe', system: ['Answer.'], user: 'Say ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['lookup'] });

  assert.deepEqual(output, { answer: 'ok' });
  assert.deepEqual(ran, [{ q: 'x' }]);
  assert.deepEqual(started, ['lookup', 'submit']);
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
  // The model is offered the host's tools only.
  for (const r of provider.messages()) for (const name of r.tools) assert.match(name, /^mcp__hands__(lookup|submit)$/, `the model was offered ${name}`);
  // The betas the pinned CLI sends: each one the policy knows.
  const betas = new Set(forwarded.flatMap((r) => (r.headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean)));
  for (const b of betas) assert.ok(CLAUDE_BETAS.has(b), `the CLI sent the beta ${b}`);
  t.diagnostic(`routes: ${[...routes].sort().join(' | ')}`);
  t.diagnostic(`betas: ${[...betas].sort().join(', ')}`);
  t.diagnostic(`requests: ${forwarded.length}, main-model: ${main}, sdk ${CLAUDE_AGENT_SDK_VERSION}`);
  assert.ok(forwarded.length >= plan.length, 'every model request came through the proxy, with the provider key');
});
