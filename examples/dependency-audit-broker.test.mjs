// A live run's model calls can go to a gateway of the host's choosing: every request reaches the base URL it is given, carries the gateway's
// credential, names the model, and nothing goes to the provider's own address. The gateway here is a local server that refuses every request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { liveModels } from './dependency-audit/live.ts';

test('with a gateway set, a model request goes to the gateway with its credential and to nobody else', { timeout: 60_000 }, async (t) => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, auth: request.headers.authorization, model: (() => { try { return JSON.parse(body).model; } catch { return undefined; } })() });
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'refused by the test gateway', type: 'invalid_request_error' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  // No provider key anywhere in this environment.
  const env = { AUDIT_MODEL_BASE_URL: base, AUDIT_MODEL_API_KEY: 'gateway-credential-for-the-test' };
  const { catalog, lead } = liveModels(env, 'openai/gpt-6-luna');
  assert.deepEqual(lead, { provider: 'openai', modelId: 'gpt-6-luna' });
  const model = catalog.getModel(lead.provider, lead.modelId);
  assert.equal(model.baseUrl, base);
  const reply = await catalog.completeSimple(model, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() }] }, {});
  assert.equal(reply.stopReason, 'error');
  assert.ok(seen.length >= 1, 'the request reached the gateway');
  assert.match(seen[0].url, /^\/v1\/responses/);
  assert.equal(seen[0].auth, 'Bearer gateway-credential-for-the-test');
  assert.equal(seen[0].model, 'gpt-6-luna');
});

test('a gateway needs its credential, only openai models are served through it, and without one the provider\'s own key is asked for', () => {
  assert.throws(() => liveModels({ AUDIT_MODEL_BASE_URL: 'http://127.0.0.1:1/v1' }), /AUDIT_MODEL_API_KEY/);
  assert.throws(() => liveModels({ AUDIT_MODEL_BASE_URL: 'http://127.0.0.1:1/v1', AUDIT_MODEL_API_KEY: 'x' }, 'anthropic/claude-haiku-5-5'), /serves openai models/);
  assert.throws(() => liveModels({}, 'openai/gpt-6-luna'), /needs OPENAI_API_KEY/);
});
