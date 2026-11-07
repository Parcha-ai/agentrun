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

/** A proxy over `policy` whose host has `notes` to give, one per call of `note` (then none), and admits each request
 *  with `ticket`; what it forwarded and what `beforeRequest` was asked, per request. */
async function proxied(t, policy, notes = [NOTE], ticket = undefined) {
  const forwarded = [];
  const asked = [];
  const taken = [];
  const takenWith = [];
  const hooks = {
    beforeRequest: async (request) => (asked.push(request), ticket),
    afterRequest: async () => {},
    note: (model, request) => (taken.push(model), takenWith.push(request), notes.shift()),
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
  return { forwarded, asked, taken, takenWith, send };
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
  // The host records the note as told only once the request carrying it is admitted: its admission says it carries one.
  assert.deepEqual([noted.asked[0].noted, plain.asked[0].noted], [true, undefined], 'the admission of the request that carries the note says so');
});

test('a token count and a small-model side call take no note; the next main-model request takes it, once', async (t) => {
  const p = await proxied(t, withNote);
  await p.send(client, '/v1/count');
  const title = { model: 'small-model', messages: [{ role: 'user', text: 'Give this conversation a title of a few words, about the report the person asked for.' }] };
  await p.send(title);
  assert.deepEqual(p.taken, [], 'no note asked for: a free route, and a request on another model');
  await p.send(client);
  await p.send(client);
  const own = p.asked[1].inputTokensMaxWithoutNote;
  assert.notEqual(p.asked[0].inputTokensMax, own, 'the side call measures apart from the main request');
  assert.deepEqual(p.takenWith.map((r) => r.inputTokensMax), [own, own], 'each take is measured on the main request itself, never on the side call before it');
  assert.deepEqual(p.forwarded.map((b) => b.messages.at(-1).role), ['user', 'user', 'note', 'user'], 'the main request after them carries it, the next does not');
  assert.deepEqual(p.asked.map((r) => r.noted ?? false), [false, true, false], 'only the admission of the request that carries it says it does');
});

test('a policy that cannot place a note forwards the body as sent and leaves the note armed', async (t) => {
  const p = await proxied(t, base);
  await p.send(client);
  assert.deepEqual(p.taken, [], 'never asked for');
  assert.deepEqual(p.forwarded[0], client);
});

test('a request its host admits only without the note (ModelTicket.noteDropped) goes as the client sent it: the cap is asked with both measures', async (t) => {
  const plain = await proxied(t, withNote, []);
  await plain.send(client);
  const p = await proxied(t, withNote, [NOTE], { turn: 1, noteDropped: true });
  await p.send(client);
  assert.deepEqual([p.asked[0].noted, p.asked[0].inputTokensMaxWithoutNote], [true, plain.asked[0].inputTokensMax], 'the admission has the request measured without the note too');
  assert.ok(p.asked[0].inputTokensMax > p.asked[0].inputTokensMaxWithoutNote, 'and with it');
  assert.deepEqual(p.forwarded[0], client, 'the body forwarded is the client\'s, without the note');
});

test('the request taking the note is measured first, as its client sent it, and handed to the host: its input bound and the output it asks for and needs, which the host prices its least by', async (t) => {
  const asks = { ...withNote, outputAsked: (body) => body.max_tokens, outputLeast: () => 10_240 };
  const plain = await proxied(t, asks, []);
  await plain.send({ ...client, max_tokens: 32_000 });
  const p = await proxied(t, asks);
  await p.send({ ...client, max_tokens: 32_000 });
  assert.deepEqual(p.takenWith, [{ inputTokensMax: plain.asked[0].inputTokensMax, outputTokensAsked: 32_000, outputTokensLeast: 10_240 }], 'the note is asked for with the request measured without it');
  assert.equal(p.asked[0].inputTokensMaxWithoutNote, plain.asked[0].inputTokensMax, 'the same measure the admission has');
});

test('a request the host sends beside the harness (a side key\'s, its host label) never takes the note: the note is never asked for on it, its body goes as sent, and it is admitted at its own bytes (its hold is its plain bound)', async (t) => {
  // The session's own request as its client sent it, with no note to give: its plain measure.
  const plain = await proxied(t, withNote, []);
  await plain.send(client);
  // A host with a note to give, and a request under a side key on the session's model.
  const forwarded = [];
  const asked = [];
  const taken = [];
  const hooks = {
    beforeRequest: async (request) => (asked.push(request), undefined),
    afterRequest: async () => {},
    note: (model, request) => (taken.push([model, request]), NOTE),
  };
  const fetch = async (_url, init) => (forwarded.push(JSON.parse(init.body)), new Response('{"usage":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const p = await startModelProxy({ policy: withNote, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  await new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.sideKey('learned_workflow')}` } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end(JSON.stringify(client));
  });
  assert.deepEqual(taken, [], 'the note is never asked for on the host\'s request');
  assert.equal(asked.length, 1, 'the host\'s request is admitted');
  assert.deepEqual([asked[0].host, asked[0].noted, asked[0].inputTokensMaxWithoutNote], ['learned_workflow', undefined, undefined], 'admitted with its host label, carrying no note');
  assert.equal(asked[0].inputTokensMax, plain.asked[0].inputTokensMax, 'admitted at its own bytes: the plain bound the session\'s own request has');
  assert.deepEqual(forwarded, [client], 'its body goes as its client sent it, without the note');
});
