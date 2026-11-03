// A provider that names Anthropic's models its own way (OpenRouter: `anthropic/claude-sonnet-5.5` for the CLI's
// `claude-sonnet-5-5`): the CLI keeps Anthropic's own id, which it knows the limits and betas of, and the session's proxy
// sends the provider's name for it in its place. The runner is still asked about, and prices, the session's model. On the
// scripted Agent SDK and a scripted Anthropic API: no key, no network, no Claude Agent CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { anthropicPolicy, claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-models-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const NAMES = { 'claude-main-5-5': 'vendor/claude-main-5.5' };
const body = (extra = {}) => ({ model: 'claude-main-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], ...extra });

test("pm-1: the policy sends the provider's name for the session's model, on both routes, and names the session's model to the runner", () => {
  const policy = anthropicPolicy({ model: 'claude-main-5-5', smallModel: 'claude-small-5-5', tools: [], auth: 'bearer', providerModels: NAMES });
  const route = (path) => policy.routes.find((r) => r.path === path);
  const sent = policy.apply(body(), route('/v1/messages'));
  assert.equal(sent.model, 'vendor/claude-main-5.5', "the provider's name goes out");
  assert.equal(policy.modelOf(sent), 'claude-main-5-5', "the runner is asked about the session's model");
  const { max_tokens: _unused, ...count } = body();
  assert.equal(policy.apply(count, route('/v1/messages/count_tokens')).model, 'vendor/claude-main-5.5', 'a token count names it the same way');
  // A model the provider gave no name goes as the CLI sent it.
  const small = policy.apply(body({ model: 'claude-small-5-5' }), route('/v1/messages'));
  assert.equal(small.model, 'claude-small-5-5');
  assert.equal(policy.modelOf(small), 'claude-small-5-5');
  // The session's own model is still the only one the CLI may ask for: the provider's name is not a way around it.
  assert.throws(() => policy.apply(body({ model: 'vendor/claude-main-5.5' }), route('/v1/messages')), /the model is not this session's/);
  // With no names, every request goes as the CLI sent it.
  assert.equal(anthropicPolicy({ model: 'claude-main-5-5', tools: [] }).apply(body(), route('/v1/messages')).model, 'claude-main-5-5');
});

test("pm-2: a session whose provider names the model its own way: the CLI runs Anthropic's id, every request reaches the provider under the provider's name", { timeout: 60_000 }, async (t) => {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const seen = [];
  const sdk = fakeSdk({ remoteModel: true, script: ['call submit {"value":{"answer":"ok"}}'], onQuery: (options) => seen.push(options.model) });
  const adapter = claudeAgentAdapter({
    model: 'claude-main-5-5',
    provider: { origin: provider.url, credential: () => 'provider-secret', auth: 'bearer', models: NAMES },
    price: (_model, usage) => (usage.input + usage.output) / 1e6,
    sessionsDir: join(scratch(), 'sessions'),
    standIn: { command: process.execPath },
    sdk,
  });
  const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
  const doc = { v: 2, name: 'claude', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'agent', label: 'task', instructions: 'Answer.', out: 'Out', as: 'final' } };
  const result = await runWorkflow(doc, {}, { runNode: createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] }) });
  assert.equal(result.status, 'complete', JSON.stringify(result.error ?? null));
  assert.ok(seen.length >= 1 && seen.every((model) => model === 'claude-main-5-5'), `the CLI runs Anthropic's id: ${JSON.stringify(seen)}`);
  const asked = provider.messages();
  assert.ok(asked.length >= 1, `${asked.length} model requests`);
  for (const r of asked) assert.deepEqual([r.path, r.model], ['/v1/messages', 'vendor/claude-main-5.5']);
});

test('pm-3: a name that is not a non-empty string is refused when the adapter is made', () => {
  const make = (models) => claudeAgentAdapter({ model: 'claude-main-5-5', provider: { origin: 'https://provider.invalid', credential: () => 'k', models }, sessionsDir: join(scratch(), 'sessions'), standIn: { command: process.execPath }, sdk: fakeSdk({}) });
  for (const models of [{ 'claude-main-5-5': '' }, { 'claude-main-5-5': 7 }, { '': 'x' }, ['x']]) assert.throws(() => make(models), /provider\.models/, JSON.stringify(models));
});
