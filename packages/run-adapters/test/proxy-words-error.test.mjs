// A translation's failure in words (serve's model-route messagesFetch: a provider's error status or a transport error,
// sent as an `event: error` whose data is the words alone, for its client to throw as the request's error): the proxy
// ends the request as an answer that ended in an error (`label: "error"`, its words the reason), booked as before, as any
// answer cut short. The host reads that end to give a server note back for the client's retry. A provider's own error
// event (JSON) is read as before, and a stream with no error event is a plain answer. No network: the provider is a
// scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-kernel/host';

const KEY = 'session-key-for-tests';
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  usageOf: () => undefined,
};
const START = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n';

/** One request through the proxy, its provider answering 200 with `stream`: how the proxy ended it. */
async function endOf(t, stream) {
  const ends = [];
  const hooks = { beforeRequest: async () => ({ turn: 1 }), afterRequest: async (_usage, _ticket, ended) => void ends.push(ended) };
  const fetch = async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const p = await startModelProxy({ policy, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  await new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end('{"model":"main-model"}');
  });
  assert.equal(ends.length, 1, 'booked once');
  return ends[0];
}

// The words error itself, at an unknown cost as before, its end saying the error: provider-cost.test.mjs.

test("a guard: a provider's own error event (JSON) before any token is read as before, a refusal at nothing", async (t) => {
  const ended = await endOf(t, `${START}event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."}}\n\n`);
  assert.equal(ended.end, 'nothing');
  assert.equal(ended.label, 'refused');
});

test('a guard: a stream with no error event is a plain answer, its usage unread an unknown cost', async (t) => {
  const ended = await endOf(t, `${START}event: message_stop\ndata: {"type":"message_stop"}\n\n`);
  assert.deepEqual(ended, { end: 'answered', usd: null });
});

test('a guard: words in a data line of an event that is no error event are no error', async (t) => {
  const ended = await endOf(t, `${START}event: ping\ndata: still here\n\n`);
  assert.deepEqual(ended, { end: 'answered', usd: null });
});
