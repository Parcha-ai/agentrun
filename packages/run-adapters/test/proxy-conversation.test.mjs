// A session's client may name the conversation a request is asked in (CONVERSATION_HEADER): the proxy tells the runner
// with the request (ProxyRequest.conversation), so a host whose harness runs several conversations at once knows whose
// request a booking is. The label is the client's own and goes no further: the provider's request never carries the
// header. A request that names none, or names something that is no id, is asked with none. No network: the provider is
// a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { CONVERSATION_HEADER, startModelProxy } from '@parcha/agentrun-kernel/host';

const KEY = 'session-key-for-tests';
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: () => ({ input: 7, output: 2, cacheRead: 0 }),
};

/** One request through the proxy with `headers`: what the runner was asked to admit, the ticket its booking was handed,
 *  and the headers the provider's request carried. */
async function sent(t, headers) {
  const asked = [];
  const booked = [];
  const upstream = [];
  const hooks = {
    beforeRequest: async (req) => (asked.push(req), { turn: asked.length }),
    afterRequest: async (_usage, ticket) => void booked.push(ticket),
  };
  const fetch = async (_url, init) => {
    upstream.push(Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value])));
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ ask: true }));
  });
  assert.equal(status, 200);
  assert.equal(asked.length, 1, 'one request asked of the runner');
  assert.equal(upstream.length, 1, 'one request sent to the provider');
  assert.deepEqual(booked, [{ turn: 1 }], 'booked once, with its own ticket');
  return { asked: asked[0], upstream: upstream[0] };
}

test('a request that names its conversation is asked of the runner with it, and the provider is never sent the header', async (t) => {
  const { asked, upstream } = await sent(t, { [CONVERSATION_HEADER]: '0199a1b2-7c3d-7e4f-8a5b-6c7d8e9f0a1b' });
  assert.equal(asked.conversation, '0199a1b2-7c3d-7e4f-8a5b-6c7d8e9f0a1b', JSON.stringify(asked));
  assert.equal(upstream[CONVERSATION_HEADER], undefined, `the label is the client's own: ${JSON.stringify(Object.keys(upstream))}`);
  assert.ok(!Object.values(upstream).some((value) => String(value).includes('0199a1b2')), 'in no header at all');
});

test('a request that names no conversation, or names something that is no id, is asked with none', async (t) => {
  assert.equal('conversation' in (await sent(t, {})).asked, false);
  for (const value of ['two words', 'a'.repeat(201), 'semi;colon', '']) {
    const { asked, upstream } = await sent(t, { [CONVERSATION_HEADER]: value });
    assert.equal('conversation' in asked, false, `${JSON.stringify(value)}: ${JSON.stringify(asked)}`);
    assert.equal(upstream[CONVERSATION_HEADER], undefined);
  }
});
