// A note the host has for the session's next main-model request (ModelProxyHooks.note, the spend cap's wrap-up): the
// proxy adds it to that request's body through the policy (addNote), after everything the client sent. It asks for the
// note once the body is measured as its admission reads it (its bytes, or the provider's or the local count), and the cap
// admits the note's bytes on top. Taken once, by a paid main-model request only: never by a
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
  const booked = [];
  const hooks = {
    beforeRequest: async (request) => (asked.push(request), ticket),
    afterRequest: async (usage, _ticket, ended) => void booked.push({ usage, ended }),
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
  return { forwarded, asked, taken, takenWith, booked, send };
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

test('a request admitted carrying the note that the proxy then never sends (released) is booked as never having left, so its host does not count the note told', async (t) => {
  // Admitted with an output limit its policy cannot write into the body (no limitOutput): released, never sent.
  const p = await proxied(t, withNote, [NOTE], { outputTokensMax: 100 });
  await p.send(client);
  assert.deepEqual([p.asked[0]?.noted, p.forwarded.length], [true, 0], 'admitted carrying the note, and never sent');
  assert.deepEqual(p.booked.map((b) => b.ended), [{ end: 'nothing', label: 'never_left' }], 'booked as never having left');
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

test('a request whose client goes while its tokens are counted never takes the note (it is counted before the note is asked for): the next request takes it and carries it at once, never after a lease runs out', async (t) => {
  // The host as the runner's wrap-up is: one offer at a time, held for the request that took it until its admission
  // tells it, or until that request gives it back (noteReturned).
  let offered;
  let takes = 0;
  const returned = [];
  const told = [];
  const asked = [];
  const forwarded = [];
  const hooks = {
    note: () => ((takes += 1), offered ? undefined : (offered = NOTE)),
    noteReturned: (note) => {
      returned.push(note);
      if (offered === note) offered = undefined;
    },
    beforeRequest: async (request) => {
      asked.push(request);
      if (request.noted) (told.push(offered), (offered = undefined));
    },
    afterRequest: async () => {},
  };
  // The provider's count: the first one hangs until its request's client goes; every later one says no count.
  let counting;
  const counted = new Promise((resolve) => (counting = resolve));
  let counts = 0;
  const fetch = async (url, init) => {
    if (String(url).endsWith('/count')) {
      counts += 1;
      if (counts > 1) return new Response('{}', { status: 404 });
      counting();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    forwarded.push(JSON.parse(init.body));
    return new Response('{"usage":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const counter = { origin: 'https://provider.invalid', path: '/count', body: (body) => body, headers: (sent) => sent, tokensOf: () => undefined };
  const p = await startModelProxy({ policy: { ...withNote, countInput: counter }, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  // Request 1's client goes while its tokens are counted, before the note is asked for.
  const first = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } });
  first.on('error', () => {});
  first.end(JSON.stringify(client));
  await counted;
  assert.equal(takes, 0, 'the note is not asked for while the request is counted');
  first.destroy();
  // Request 2 takes it at once and carries it: admitted with it, told once, forwarded with it.
  const at = Date.now();
  await new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end(JSON.stringify(client));
  });
  assert.ok(Date.now() - at < 5_000, `carried at once: ${Date.now() - at} ms`);
  assert.deepEqual([takes, returned], [1, []], 'asked for once, by the request that carried it; nothing given back');
  assert.deepEqual([asked.map((r) => r.noted ?? false), told], [[true], [NOTE]], 'the next request is admitted carrying it, told once');
  assert.deepEqual(forwarded.map((b) => b.messages.at(-1)), [{ role: 'note', text: NOTE }], 'and sent with it');
});

test('a note its policy fails to place is given back at once: the request goes as its client sent it, and the next one carries the note', async (t) => {
  let offered;
  let fail = true;
  const returned = [];
  const asked = [];
  const forwarded = [];
  const hooks = {
    note: () => (offered ? undefined : (offered = NOTE)),
    noteReturned: (note) => (returned.push(note), offered === note && (offered = undefined)),
    beforeRequest: async (request) => (asked.push(request), request.noted ? (offered = undefined) : undefined),
    afterRequest: async () => {},
  };
  const placing = { ...withNote, addNote: (body, text) => { if (fail) { fail = false; throw new Error('no place for it'); } return withNote.addNote(body, text); } };
  const fetch = async (_url, init) => (forwarded.push(JSON.parse(init.body)), new Response('{"usage":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const p = await startModelProxy({ policy: placing, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  const send = () => new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end(JSON.stringify(client));
  });
  await send();
  assert.deepEqual([returned, asked.map((r) => r.noted ?? false), forwarded], [[NOTE], [false], [client]], 'given back once; the request admitted and sent as its client sent it');
  await send();
  assert.deepEqual(asked.map((r) => r.noted ?? false), [false, true], 'the next request carries it');
  assert.deepEqual(forwarded[1].messages.at(-1), { role: 'note', text: NOTE });
});

/** A host whose cap is the wrap-up's: the note it is asked for with (NoteRequest) and every admission, per request. */
async function counting(t, policy) {
  const takenWith = [];
  const asked = [];
  const forwarded = [];
  const hooks = {
    note: (_model, request) => (takenWith.push(request), takenWith.length === 1 ? NOTE : undefined),
    beforeRequest: async (request) => void asked.push(request),
    afterRequest: async () => {},
  };
  const fetch = async (url, init) => {
    if (String(url).endsWith('/count')) return new Response(JSON.stringify({ input_tokens: 40 }), { status: 200, headers: { 'content-type': 'application/json' } });
    forwarded.push(init.body);
    return new Response('{"usage":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const p = await startModelProxy({ policy, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  await new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end(JSON.stringify(client));
  });
  return { takenWith, asked, forwarded };
}

test('the note is asked for on the input count its admission reads: a local count (a gateway, serve\'s translation) and not the body\'s bytes; the noted request is that count and the note\'s bytes', async (t) => {
  const local = { ...withNote, countInputLocally: () => 30 };
  const { takenWith, asked, forwarded } = await counting(t, local);
  const plainBytes = Buffer.byteLength(JSON.stringify(client));
  assert.ok(plainBytes > 30, `the body is ${plainBytes} bytes, more than its count`);
  assert.deepEqual(takenWith, [{ inputTokensMax: 30 }], 'the note is asked for with the count, not the bytes');
  assert.equal(asked[0].inputTokensMaxWithoutNote, 30, 'the same figure the admission has without the note');
  const added = Buffer.byteLength(forwarded[0]) - plainBytes;
  assert.equal(asked[0].inputTokensMax, 30 + added, `with the note: the count and the ${added} bytes the note adds`);
});

test('the note is asked for on the provider\'s count where its admission reads one, and the local count is not taken then', async (t) => {
  let localCounts = 0;
  const counter = { origin: 'https://provider.invalid', path: '/count', body: (body) => body, headers: (sent) => sent, tokensOf: (answer) => answer.input_tokens };
  const provider = { ...withNote, countInput: counter, countInputLocally: () => ((localCounts += 1), 35) };
  const { takenWith, asked } = await counting(t, provider);
  assert.deepEqual(takenWith, [{ inputTokensMax: 40 }], 'the note is asked for with the provider\'s count');
  assert.deepEqual([asked[0].inputTokensMaxWithoutNote, localCounts], [40, 0], 'the admission\'s figure without the note; no local count');
});
