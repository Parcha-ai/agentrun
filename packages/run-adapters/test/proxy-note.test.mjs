// A note the host has for the session's next main-model request (ModelProxyHooks.note, the spend cap's wrap-up): the
// proxy adds it to that request's body through the policy (addNote), after everything the client sent, before it
// measures the body, so the cap admits the note's bytes too. Taken once, by a paid main-model request only: never by a
// free route (a token count) or a client's small-model side call, and never when the policy cannot place it. No network:
// the provider is a recording fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-kernel/host';

const KEY = 'session-key-for-tests';
const NOTE = 'About $0.07 left of this run\'s budget: finish now with your answer.';
const base = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }, { method: 'POST', path: '/v1/count', free: true }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  modelOf: (body) => body.model,
  usageOf: () => ({ input: 7, output: 2, cacheRead: 0 }),
};
/** The policy's note: one trailing message after everything the client sent. */
const withNote = { ...base, addNote: (body, text) => ({ ...body, messages: [...body.messages, { role: 'note', text }] }) };

/** A proxy over `policy` whose host has `notes` to give, one per call of `note` (then none); what it forwarded and what
 *  `beforeRequest` was asked, per request. */
async function proxied(t, policy, notes = [NOTE]) {
  const forwarded = [];
  const asked = [];
  const taken = [];
  const hooks = {
    beforeRequest: async (request) => void asked.push(request),
    afterRequest: async () => {},
    note: (model) => (taken.push(model), notes.shift()),
  };
  const fetch = async (_url, init) => (forwarded.push(JSON.parse(init.body)), new Response('{"usage":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const p = await startModelProxy({ policy, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  const send = (body, path = '/v1/test') => new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path, headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end(JSON.stringify(body));
  });
  return { forwarded, asked, taken, send };
}
const client = { model: 'main-model', messages: [{ role: 'user', text: 'Write the report.', cache: true }, { role: 'assistant', text: 'Reading.' }, { role: 'user', text: 'tool result' }] };

test('the note goes after everything the client sent: the forwarded body is the client\'s, byte for byte up to the note, and the cap measures the note\'s bytes', async (t) => {
  const plain = await proxied(t, withNote, []);
  await plain.send(client);
  const noted = await proxied(t, withNote);
  await noted.send(client);
  const body = noted.forwarded[0];
  assert.deepEqual(body?.messages?.at(-1), { role: 'note', text: NOTE }, 'the note, last');
  assert.equal(JSON.stringify(body.messages.slice(0, -1)), JSON.stringify(client.messages), 'the client\'s messages as sent: the cached prefix unchanged');
  assert.ok(noted.asked[0].inputTokensMax - plain.asked[0].inputTokensMax >= Buffer.byteLength(NOTE), `the note's bytes are measured: ${noted.asked[0].inputTokensMax} vs ${plain.asked[0].inputTokensMax}`);
});

test('a token count and a small-model side call take no note; the next main-model request takes it, once', async (t) => {
  const p = await proxied(t, withNote);
  await p.send(client, '/v1/count');
  await p.send({ ...client, model: 'small-model' });
  assert.deepEqual(p.taken, [], 'no note asked for: a free route, and a request on another model');
  await p.send(client);
  await p.send(client);
  assert.deepEqual(p.forwarded.map((b) => b.messages.at(-1).role), ['user', 'user', 'note', 'user'], 'the main request after them carries it, the next does not');
});

test('a policy that cannot place a note forwards the body as sent and leaves the note armed', async (t) => {
  const p = await proxied(t, base);
  await p.send(client);
  assert.deepEqual(p.taken, [], 'never asked for');
  assert.deepEqual(p.forwarded[0], client);
});
