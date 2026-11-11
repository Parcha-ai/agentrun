// A side call on the session's own model (a title, a summary: a request the policy reads as no answer of the turn,
// ProviderPolicy.answers) is a side call to the runner as one on another model is: its request carries `side`, so the
// cap never prices the session's next request from it (expected pricing's previous request) and never counts it a typical
// answer. The turn's answer request carries none. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { modelPortFor } from '@parcha/agentrun-kernel';
import { startModelProxy } from '@parcha/agentrun-kernel/host';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const KEY = 'session-key-for-tests';
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: () => ({ input: 7, output: 2, cacheRead: 0 }),
  // The turn's answer request offers the session's tools; a title or summary offers none.
  answers: (body) => body.tools === true,
};

/** The request the runner was asked to admit for `body`, sent on the session's model through the proxy. */
async function asked(t, body) {
  const seen = [];
  const store = memorySessionStore();
  const booking = await modelPortFor(await store.open('chat:s'), { key: 'chat:s', beforeRequest: (req) => (seen.push(req), { holdUsd: 0.01 }) });
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: booking.models, price: () => 0.001, log: () => {}, fetch: async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }) }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  await new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end(JSON.stringify(body));
  });
  assert.equal(seen.length, 1, 'one request asked of the runner');
  return seen[0];
}

test("a side call on the session's own model (no answer of the turn) is asked of the runner as a side call", async (t) => {
  const side = await asked(t, { title: 'name this chat' });
  assert.equal(side.model, 'session-model', 'on the session model');
  assert.equal(side.side, true, `a side call: ${JSON.stringify(side)}`);
});

test("the turn's answer request on the session's model is no side call", async (t) => {
  const answer = await asked(t, { tools: true });
  assert.equal(answer.side, undefined, `the turn's own: ${JSON.stringify(answer)}`);
});
