// Managed ChatGPT sign-in and source-native sign-in are independent. Exercise the real API, sealed store and runner;
// only the source CLIs and sign-out's revocation endpoint are fakes. No OAuth flow or model request is sent.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatGPTPlan, CHATGPT_PLAN_ROW } from '../dist/chatgpt-plan.js';
import { MODEL_KEYS } from '../dist/model.js';
import { putSealedKey } from '../dist/server-keys.js';
import { follow, journalOf, serve, withEnv } from './support.mjs';
import { nativeFixture } from './native-fixtures/setup.mjs';

const MODEL_VARS = ['AGENT_MODEL_BASE_URL', 'AGENT_MODEL', 'AGENT_MODEL_FAST', 'AGENT_MODEL_STRONG', 'AGENT_MODEL_API_KEY', 'AGENT_MODEL_GATEWAY_IDS', 'AGENTRUN_SERVE_DEFAULT_MODEL', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', ...MODEL_KEYS.map(row => row.field)];
const taskCalls = calls => calls.filter(call => call.args.includes('--print') || call.args.includes('exec'));

for (const runtime of ['claude-code', 'codex']) {
  test(`${runtime} keeps source authentication, named selection and model when the managed ChatGPT plan signs in and out`, { timeout: 60_000 }, async t => {
    const fixture = await nativeFixture(t);
    const sealKey = randomBytes(32);
    const nativeEnv = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NATIVE_TEST_LOG'].map(name => [name, fixture.env[name]]));
    withEnv(t, { ...nativeEnv, AGENTRUN_SEAL_KEY: sealKey.toString('base64'), AGENT_THINKING: 'high' }, [
      ...MODEL_VARS, 'NATIVE_TEST_AUTH', 'NATIVE_TEST_EVENTS', 'NATIVE_TEST_HOLD', 'NATIVE_TEST_ECHO', 'NATIVE_TEST_DENY', 'NATIVE_TEST_MALFORMED',
    ]);
    const selector = { kind: runtime === 'codex' ? 'profile' : 'agent', name: 'source-review' };
    const model = `source-${runtime}-model`;
    const source = runtime === 'codex'
      ? [[join(fixture.home, '.codex', 'config.toml'), 'model = "source-base"\n'], [join(fixture.home, '.codex', 'source-review.config.toml'), `model = "${model}"\nmodel_reasoning_effort = "low"\n`]]
      : [[join(fixture.project, '.claude', 'settings.json'), '{"model":"source-base"}\n'], [join(fixture.project, '.claude', 'agents', 'source-review.md'), `---\nname: source-review\nmodel: ${model}\ndescription: Source review\n---\nReview the source project.\n`]];
    for (const [path, content] of source) await fixture.put(path, content);

    const credential = { type: 'oauth', access: randomBytes(32).toString('hex'), refresh: randomBytes(32).toString('hex'), expires: Date.now() + 3_600_000, clientId: 'native-boundary-fixture' };
    const requests = [];
    const realFetch = globalThis.fetch;
    let localOrigin;
    // Trap even a managed token read that fails before reaching a provider. Native dispatch needs neither reader.
    const tokens = t.mock.method(ChatGPTPlan.prototype, 'token', async () => { throw new Error('Native execution requested the managed plan token.'); });
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === localOrigin) return realFetch(input, init);
      requests.push(`${request.method} ${request.url}`);
      if (request.url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
      if (request.url === 'https://auth.openai.com/oauth/revoke' && request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get('token'), credential.refresh);
        assert.equal(form.get('client_id'), credential.clientId);
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected network request: ${request.method} ${new URL(request.url).origin}`);
    });
    const { api, data, store, baseUrl } = await serve(t, { faux: undefined, harnesses: false });
    localOrigin = new URL(baseUrl).origin;
    assert.deepEqual((await api('GET', '/settings/chatgpt')).body, { state: 'signed_out' });
    await putSealedKey(store, sealKey, CHATGPT_PLAN_ROW, JSON.stringify({ v: 1, state: 'signed_in', credential, models: ['gpt-6.1-sol'] }));
    assert.equal((await api('GET', '/settings/chatgpt')).body.state, 'signed_in');
    const managed = (await api('GET', '/capabilities')).body.models;
    assert.equal(managed.ready, true);
    assert.equal(managed.source, 'chatgpt');
    assert.equal(managed.default, 'chatgpt/gpt-6.1-sol', 'the conflicting managed default is actually active');

    const connected = await api('POST', '/native/connect', { project: fixture.project, runtime, selector });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const id = connected.body.agent.agent_id;
    const assertSource = native => {
      assert.equal(native.runtime, runtime);
      assert.equal(native.project, fixture.project);
      assert.deepEqual(native.selector, selector);
      assert.equal(native.model, model);
    };
    assertSource(connected.body.agent.definition.native);

    for (const state of ['signed_in', 'signed_out']) {
      if (state === 'signed_out') {
        const signedOut = await api('DELETE', '/settings/chatgpt');
        assert.deepEqual([signedOut.status, signedOut.body], [200, { revoked: true }]);
        assert.deepEqual((await api('GET', '/settings/chatgpt')).body, { state: 'signed_out' });
        assert.equal((await api('GET', '/capabilities')).body.models.ready, false, 'no managed model remains available');
      }
      process.env.NATIVE_TEST_AUTH = 'no';
      const before = taskCalls(await fixture.calls()).length;
      const unverified = await api('POST', `/agents/${id}/native/verify`, {});
      assert.equal(unverified.status, 200);
      assert.equal(unverified.body.native.state, 'needs_attention', state);
      assert.match(unverified.body.native.issues.join(' '), /Sign in with/);
      const refused = await api('POST', `/agents/${id}/runs`, { input: { content: 'Use the source configuration.' } });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.match(refused.body.error.message, /Sign in with/);
      assert.equal(taskCalls(await fixture.calls()).length, before, 'managed sign-in never substitutes for source authentication');

      process.env.NATIVE_TEST_AUTH = 'yes';
      const verified = await api('POST', `/agents/${id}/native/verify`, {});
      assert.equal(verified.status, 200);
      assert.equal(verified.body.native.state, 'ready', state);
      assertSource(verified.body.native);
      for (const [field, value] of Object.entries({ model: 'chatgpt/gpt-6.1-sol', thinking: 'medium' })) {
        const refusedEdit = await api('PUT', `/agents/${id}/definition`, { definition: { instructions: '', [field]: value } });
        assert.equal(refusedEdit.status, 422, JSON.stringify(refusedEdit.body));
        assert.ok(refusedEdit.body.error.fields.some(issue => issue.field === `definition.${field}`));
      }
      const started = await api('POST', `/agents/${id}/runs`, { input: { content: 'Use the source configuration.' } });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      const { last } = await follow(api, started.body.run_id, ['completed', 'failed']);
      assert.equal(last.status, 'completed', JSON.stringify(last));
      const { body: launch } = await store.runs.launch(started.body.run_id);
      assertSource(launch.native);
      assert.equal(launch.model, undefined);
      assert.equal(launch.effort, undefined, 'managed thinking defaults do not override source effort');
      const records = journalOf(data, started.body.run_id);
      assert.deepEqual(records.filter(row => row.kind === 'runner.request').map(row => row.data.model), [model]);
      const view = (await api('GET', `/runs/${started.body.run_id}`)).body;
      assert.equal(view.result.final_answer, 'native answer');
      assert.equal(view.native.runtime, runtime);
      const calls = taskCalls(await fixture.calls());
      assert.equal(calls.length, before + 1, 'one task reaches the source CLI');
      const call = calls.at(-1);
      assert.equal(call.runtime, runtime === 'codex' ? 'codex' : 'claude');
      assert.equal(call.cwd, fixture.project);
      assert.equal(call.home, fixture.home);
      assert.equal(call.codexHome, fixture.env.CODEX_HOME);
      const flag = runtime === 'codex' ? '--profile' : '--agent';
      assert.equal(call.args[call.args.indexOf(flag) + 1], selector.name);
      assert.ok(!call.args.some(arg => arg === '--model' || arg.includes('chatgpt/') || arg.includes('model=')));
      assert.equal(tokens.mock.callCount(), 0, 'native claims do not read the managed plan token');
      assert.equal(requests.length, state === 'signed_in' ? 0 : 2, 'only explicit sign-out reaches the fake auth endpoint');
      for (const [path, content] of source) assert.equal(await readFile(path, 'utf8'), content, 'source configuration is unchanged');
    }
    assert.deepEqual(requests, ['GET https://auth.openai.com/.well-known/openid-configuration', 'POST https://auth.openai.com/oauth/revoke']);
  });
}
