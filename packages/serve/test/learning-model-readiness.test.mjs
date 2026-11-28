import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilities } from '../dist/server.js';

test('a gateway that accepts caller model keys is not a configured background learning model', async () => {
  const caps = await capabilities({ AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9', AGENT_MODEL: 'openai/gpt-6.1-sol', AGENTRUN_BOXES: 'none' });
  assert.equal(caps.models.ready, true, 'ordinary runs may supply their own gateway key');
  assert.equal(caps.learning_model?.ready, false, 'background learning needs a server-owned model credential');
  assert.equal(caps.learning_model.needs, 'key');
  assert.equal(caps.learning_model.location, 'server');
});

test('learning requires credentials for its selected model, not any saved API key', async () => {
  const { learningModelOf } = await import('../dist/learning-model.js');
  const sdk = model => ({ kind: 'agentic', body: { sdk: { runtime: 'eve' }, ...(model ? { model } : {}) } });
  const toolOnly = await learningModelOf({ TYPESAFE_API_KEY: 'fake-test-key', FAL_KEY: 'fake-test-key' }, sdk());
  assert.equal(toolOnly.ready, false);
  assert.equal(toolOnly.needs, 'key');
  const direct = { OPENAI_API_KEY: 'fake-test-key' };
  const ready = await learningModelOf(direct, sdk());
  assert.equal(ready.ready, true);
  assert.equal(ready.model, 'openai/gpt-6.1-sol');
  const wrongProvider = await learningModelOf(direct, sdk('anthropic/claude-sonnet-5-5'));
  assert.equal(wrongProvider.ready, false);
  assert.equal(wrongProvider.needs, 'key');
  assert.equal(wrongProvider.model, 'anthropic/claude-sonnet-5-5');
  assert.match(wrongProvider.reason, /Anthropic/);
  const unknown = await learningModelOf(direct, sdk('openai/not-a-model'));
  assert.equal(unknown.ready, false);
  assert.equal(unknown.needs, 'model');
  const matching = await learningModelOf({ ANTHROPIC_API_KEY: 'fake-test-key' }, sdk('anthropic/claude-sonnet-5-5'));
  assert.equal(matching.ready, true);
  const wrongWire = await learningModelOf(direct, { kind: 'agentic', body: { harness: 'claude-agent', model: 'openai/gpt-6.1-sol' } });
  assert.equal(wrongWire.ready, false);
  assert.equal(wrongWire.needs, 'model', 'a key cannot make Claude Agent run an OpenAI model');
  assert.match(wrongWire.reason, /Anthropic models/);
  const router = await learningModelOf({ OPENROUTER_API_KEY: 'fake-test-key' }, sdk());
  assert.equal(router.ready, true);
  assert.equal(router.model, 'openrouter/openai/gpt-6.1-sol');
});

test('gateway key and model are both required for background compilation', async () => {
  const { learningModelOf } = await import('../dist/learning-model.js');
  const gateway = { AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9', AGENT_MODEL: 'openai/gpt-6.1-sol' };
  assert.equal((await learningModelOf(gateway)).ready, false);
  const directClaude = await learningModelOf({ ...gateway, ANTHROPIC_API_KEY: 'fake-test-key' }, { kind: 'agentic', body: { harness: 'claude-agent', model: 'anthropic/claude-sonnet-5-5' } });
  assert.equal(directClaude.ready, true, 'an unrelated keyless gateway does not block managed Claude on its direct key');
  assert.equal((await learningModelOf({ ...gateway, AGENT_MODEL_API_KEY: 'fake-test-key' })).ready, true);
  assert.equal((await learningModelOf({ AGENT_MODEL_BASE_URL: gateway.AGENT_MODEL_BASE_URL, AGENT_MODEL_API_KEY: 'fake-test-key' })).ready, false);
});

test('a managed agent on a keyless gateway server compiles, checks and audits on each run\'s own key; an SDK agent still needs the server\'s', async () => {
  const { learningModelOf } = await import('../dist/learning-model.js');
  const gateway = { AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9', AGENT_MODEL: 'openai/gpt-6.1-sol' };
  const managed = await learningModelOf(gateway, { kind: 'agentic', body: { instructions: 'Answer.' } });
  assert.deepEqual([managed.location, managed.ready, managed.needs], ['server', true, null], JSON.stringify(managed));
  assert.match(managed.reason, /^Compiles, checks and audits on each run's own model key \(`model_key`\): this server holds no gateway key of its own\./);
  assert.match(managed.reason, /`learning_work`/);
  const sdk = await learningModelOf(gateway, { kind: 'agentic', body: { sdk: { runtime: 'eve' } } });
  assert.deepEqual([sdk.ready, sdk.needs], [false, 'key']);
  assert.match(sdk.reason, /tied to no run, so it cannot use a run's own key/);
});

test('managed Cursor learning uses its installed plan harness and own key, not a server model proxy', async t => {
  const { learningModelOf } = await import('../dist/learning-model.js');
  const { HARNESS_TABLE_ENV } = await import('../dist/harness-table.js');
  const { scratch } = await import('./support.mjs');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const file = join(await scratch(t), 'cursor-readiness.cjs');
  // Only the installed adapter boundary stands in: Cursor's real plan facts and model validation remain in use.
  writeFileSync(file, `module.exports = { calls: [], entries: () => ({ cursor: {
    hidden: env => env.CURSOR_TEST_INSTALLED ? undefined : 'Cursor release is not installed.',
    refusal: async (env, given) => {
      module.exports.calls.push(given.model);
      if (env.CURSOR_TEST_REFUSAL) return { reason: env.CURSOR_TEST_REFUSAL };
      return env.CURSOR_API_KEY ? undefined : { reason: 'Cursor requires CURSOR_API_KEY on this server.' };
    },
  } }) };`);
  const fixture = createRequire(import.meta.url)(file);
  const env = { NODE_TEST_CONTEXT: 'child-v8', [HARNESS_TABLE_ENV]: file, CURSOR_TEST_INSTALLED: '1', CURSOR_API_KEY: 'fake-test-key',
    AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9', AGENT_MODEL: 'openai/gpt-6.1-sol' };
  const agent = { kind: 'agentic', body: { harness: 'cursor', model: 'cursor/default' } };
  const ready = await learningModelOf(env, agent);
  assert.deepEqual(ready, { location: 'server', ready: true, model: 'cursor/default', needs: null, reason: null }, 'Cursor compiles in its own session, without an AgentRun model gateway credential');
  assert.deepEqual(fixture.calls, [{ provider: 'cursor', modelId: 'default' }], 'readiness still checks the installed adapter with the selected model');
  const noKey = await learningModelOf({ ...env, CURSOR_API_KEY: undefined }, agent);
  assert.equal(noKey.ready, false);
  assert.equal(noKey.needs, 'key');
  assert.match(noKey.reason, /CURSOR_API_KEY/);
  const notInstalled = await learningModelOf({ ...env, CURSOR_TEST_INSTALLED: undefined }, agent);
  assert.equal(notInstalled.ready, false);
  assert.equal(notInstalled.needs, 'model');
  assert.match(notInstalled.reason, /not installed/);
  const refused = await learningModelOf({ ...env, CURSOR_TEST_REFUSAL: 'Cursor release verification failed.' }, agent);
  assert.equal(refused.ready, false);
  assert.equal(refused.needs, 'model');
  assert.equal(refused.reason, 'Cursor release verification failed.');
  const wrongModel = await learningModelOf(env, { kind: 'agentic', body: { harness: 'cursor', model: 'openai/gpt-6.1-sol' } });
  assert.equal(wrongModel.ready, false);
  assert.equal(wrongModel.needs, 'model');
  assert.match(wrongModel.reason, /Cursor runs a model Cursor lists/);
  const sdk = await learningModelOf(env, { kind: 'agentic', body: { harness: 'cursor', model: 'cursor/default', sdk: { runtime: 'eve' } } });
  assert.equal(sdk.ready, false, 'an SDK application cannot borrow the managed Cursor session for separate server compilation');
});

test('Cursor learning does not claim an unavailable real installation is ready just because it has its own key', async t => {
  const { learningModelOf } = await import('../dist/learning-model.js');
  const { DATA_ENV } = await import('../dist/files.js');
  const { scratch } = await import('./support.mjs');
  const access = await learningModelOf({ [DATA_ENV]: await scratch(t), CURSOR_API_KEY: 'fake-test-key' }, { kind: 'agentic', body: { harness: 'cursor' } });
  assert.equal(access.ready, false);
  assert.equal(access.needs, 'model');
  assert.match(access.reason, /HARNESS_NOT_INSTALLED|ACP_BINARY_UNPINNED/);
});

test('native sign-in and managed Claude or ChatGPT sign-in are not misreported as missing API keys', async () => {
  const { learningModelOf } = await import('../dist/learning-model.js');
  const { withClaudeLogin } = await import('../dist/claude-login.js');
  const { withPlan } = await import('../dist/chatgpt-plan.js');
  const native = { runtime: 'codex', project: '/workspace/project', selector: { kind: 'project' }, machine_id: 'source', version: '1', model: 'source-model', fingerprint: 'fingerprint', configuration: [], skills: [], mcp_servers: [], state: 'ready', issues: [], connected: true, capabilities: { launch: true, learning: true, workflows: false, approval: 'native', usage: true } };
  const own = await learningModelOf({}, { kind: 'agentic', body: { native } });
  assert.equal(own.location, 'native');
  assert.equal(own.ready, true);
  assert.equal(own.needs, null);
  assert.equal(own.model, 'source-model');
  assert.equal((await learningModelOf({}, { kind: 'agentic', body: { harness: 'claude-agent', model: 'anthropic/claude-sonnet-5-5' } })).ready, false);
  const login = withClaudeLogin({}, { dir: '/fixture/login', profiles: '/fixture/login/anthropic' });
  assert.equal((await learningModelOf(login, { kind: 'agentic', body: { harness: 'claude-agent' } })).ready, true);
  assert.equal((await learningModelOf(login, { kind: 'agentic', body: { sdk: { runtime: 'claude-agent-sdk' }, harness: 'claude-agent' } })).ready, false, 'SDK compile cannot copy the original runtime login');
  let tokenReads = 0;
  const plan = withPlan({}, { state: 'signed_in', models: ['gpt-6.1-sol'], token: async () => { tokenReads++; return 'fake-test-key'; }, refused: async () => {}, watch() {} });
  assert.equal((await learningModelOf(plan)).ready, true);
  assert.equal((await learningModelOf(plan, { kind: 'agentic', body: { harness: 'codex' } })).ready, true);
  const sdk = { kind: 'agentic', body: { sdk: { runtime: 'codex-sdk' } } };
  assert.equal((await learningModelOf(plan, sdk)).ready, true);
  assert.equal(tokenReads, 0, 'readiness metadata must not read or renew the managed plan token');
  assert.equal((await learningModelOf(plan, sdk, { checkCredential: true })).ready, true);
  assert.equal(tokenReads, 1, 'SDK admission checks the credential only after its durable receipt lookup');
});

test('agent learning and default readiness refresh when the matching model key is saved or removed', async t => {
  const { serve, withEnv } = await import('./support.mjs');
  const { MODEL_KEYS } = await import('../dist/model.js');
  withEnv(t, {}, ['AGENT_MODEL', 'AGENT_MODEL_FAST', 'AGENT_MODEL_STRONG', 'AGENT_MODEL_BASE_URL', 'AGENT_MODEL_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', ...MODEL_KEYS.map(key => key.field)]);
  const server = await serve(t, { faux: undefined, harnesses: false, runner: false });
  const created = await server.api('POST', '/agents', { definition: { name: 'Existing backend', instructions: 'Answer normally.', sdk: { runtime: 'eve' }, learning: true, tools: [] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.agent_id;
  const read = async () => (await server.api('GET', `/agents/${id}/learning`)).body.learning_model;
  assert.equal((await read()).ready, false);
  assert.equal((await server.api('GET', '/capabilities')).body.learning_model.ready, false);
  const start = await server.api('POST', `/agents/${id}/sdk-runs`, { runtime: 'eve', input: 'Check status.', instructions: 'Answer normally.' }, { 'Idempotency-Key': 'no-model' });
  assert.equal(start.status, 409);
  assert.equal((await server.api('PUT', '/settings/tool-keys/openai', { values: { OPENAI_API_KEY: 'fake-test-key' } })).status, 204);
  assert.equal((await read()).ready, true);
  assert.equal((await read()).model, 'openai/gpt-6.1-sol');
  assert.equal((await server.api('GET', '/capabilities')).body.learning_model.ready, true);
  const admission = { runtime: 'eve', input: 'Check status.', instructions: 'Answer normally.' };
  const admitted = await server.api('POST', `/agents/${id}/sdk-runs`, admission, { 'Idempotency-Key': 'recover-after-settings-change' });
  assert.equal(admitted.status, 201, JSON.stringify(admitted.body));
  await server.api('PUT', `/agents/${id}/definition`, { definition: { model: 'anthropic/claude-sonnet-5-5', instructions: 'Answer normally.' } });
  assert.equal((await read()).ready, false, 'agent override does not inherit readiness from a different default provider');
  assert.equal((await read()).model, 'anthropic/claude-sonnet-5-5');
  assert.equal((await server.api('GET', '/capabilities')).body.learning_model.ready, true);
  assert.equal((await server.api('DELETE', '/settings/tool-keys/openai')).status, 204);
  assert.equal((await server.api('GET', '/capabilities')).body.learning_model.ready, false);
  const retry = await server.api('POST', `/agents/${id}/sdk-runs`, admission, { 'Idempotency-Key': 'recover-after-settings-change' });
  assert.equal(retry.status, 201, 'a successful SDK receipt remains recoverable after its model or credentials change');
  assert.equal(retry.body.run_id, admitted.body.run_id);
  assert.equal(typeof admitted.body.token, 'string');
  assert.equal(retry.body.token, admitted.body.token);
  const refused = await server.api('POST', `/agents/${id}/sdk-runs`, admission, { 'Idempotency-Key': 'new-run-still-needs-key' });
  assert.equal(refused.status, 409);
  assert.equal((await server.store.runs.list({ agentId: id })).length, 1, 'readiness reads, retries and refused SDK starts do not create additional runs');
});
