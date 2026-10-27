// The provider-neutral model proxy, attacked from the side a harness sits on, under a test policy; and the copied
// layer's pieces a harness waits and builds tools with. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';
import { z } from 'zod';
import { matchRoute, parseStrict, ProxyRefusal, startModelProxy } from '@parcha/agentrun-adapters/host';
import { openDrive } from '@parcha/agentrun-adapters/kernel';
import { waitForSubmissions, zodShapeFromJsonSchema } from '@parcha/agentrun-adapters/process';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';

const KEY = 'session-key-for-tests';
/** A provider's rules, for the tests: one route, a bearer key, the model fixed, a `hosted` tool refused. */
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test', headers: ['x-request-id'] }],
  keyOf: (headers) => { const auth = String(headers.authorization ?? ''); return auth.startsWith('Bearer ') ? auth.slice(7) : ''; },
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProxyRefusal(400, 'the body is not an object');
    if ((body.tools ?? []).some((t) => t.type === 'hosted')) throw new ProxyRefusal(403, 'a hosted tool is not offered');
    return { ...body, model: 'session-model' };
  },
  usageOf(text) {
    const m = [...text.matchAll(/"usage":\{"in":(\d+),"out":(\d+)\}/g)].at(-1);
    return m ? { input: Number(m[1]), output: Number(m[2]), cacheRead: 0 } : undefined;
  },
};
const sse = (usage = { in: 7, out: 2 }) => `data: {"delta":"hi"}\n\ndata: {"done":true,"usage":${JSON.stringify(usage)}}\n\n`;

/** A proxy with recorded hooks and a provider that records what reached it. */
async function proxy(t, extra = {}) {
  const forwarded = [];
  const hooks = { before: [], after: [] };
  const p = await startModelProxy({
    policy: extra.policy ?? policy,
    model: 'session-model',
    origin: 'https://provider.invalid/ignored/path',
    credential: extra.credential ?? (() => 'provider-secret'),
    hooks: { beforeRequest: async (r) => { hooks.before.push(r); if (extra.refuse) throw new Error(extra.refuse); }, afterRequest: async (u) => { hooks.after.push(u); } },
    price: () => 0.001,
    fetch: extra.fetch ?? (async (url, init) => { forwarded.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }); }),
  }, KEY);
  t.after(() => p.close());
  return { p, forwarded, hooks };
}

/** A raw request to the proxy: any method, any path text, any key, any headers. */
function send(url, { method = 'POST', path = '/v1/test', key = KEY, headers = {}, body = { model: 'other', input: 'hi' } } = {}) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

/** Whether a TCP connection to `host:port` opens. */
const opens = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  socket.setTimeout(2_000, () => { socket.destroy(); resolve(false); });
});

test('the proxy listens on loopback only and admits only the session key', async (t) => {
  const { p, forwarded } = await proxy(t);
  assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  // Bound to loopback, not every interface: this host's own non-loopback addresses do not reach it.
  const port = Number(new URL(p.url).port);
  assert.equal(await opens('127.0.0.1', port), true);
  for (const address of Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === 'IPv4').map((a) => a.address)) {
    assert.equal(await opens(address, port), false, `reachable on ${address}`);
  }
  for (const key of [null, '', 'wrong', `${KEY}x`, KEY.slice(0, -1)]) assert.equal((await send(p.url, { key })).status, 401, `key ${JSON.stringify(key)}`);
  assert.equal(forwarded.length, 0);
  assert.equal((await send(p.url)).status, 200);
  assert.equal(forwarded.length, 1);
  await assert.rejects(startModelProxy({ policy, model: 'm', origin: 'https://x.invalid', credential: () => 'c', hooks: {} }, ''), /needs the session's key/);
});

test("only the policy's routes, by their exact text: an absolute URL, a foreign path, an escape or a query is refused", async (t) => {
  const { p, forwarded } = await proxy(t);
  const refused = ['http://evil.example/v1/test', '//evil.example/v1/test', '/v1/test/../files', '/v1/%74est', '/v1/test?x=1', '/v1/files', '/v1/test/', '/v1//test', '/V1/test'];
  for (const path of refused) assert.equal((await send(p.url, { path })).status, 403, path);
  for (const method of ['GET', 'PUT']) assert.equal((await send(p.url, { method })).status, 403, method);
  assert.equal(forwarded.length, 0, 'nothing refused reached the provider');
  assert.throws(() => matchRoute(policy.routes, 'POST', 'v1/test'), /not one the table can match/);
});

test("the provider gets the policy's body, its own credential, the route's path and only the route's listed headers", async (t) => {
  const { p, forwarded } = await proxy(t);
  const r = await send(p.url, { headers: { 'x-request-id': 'r1', 'x-other': 'leak', cookie: 'c=1' } });
  assert.equal(r.status, 200);
  const [f] = forwarded;
  assert.equal(f.url, 'https://provider.invalid/v1/test', "the origin's own path is never used");
  assert.deepEqual(f.headers, { 'content-type': 'application/json', 'x-request-id': 'r1', authorization: 'Bearer provider-secret' });
  assert.equal(f.body.model, 'session-model');
  assert.ok(!JSON.stringify(f).includes(KEY), 'the session key never reaches the provider');
  // The answer carries the provider's body and its content type, nothing else of the provider's: no header of its own,
  // and never the credential.
  assert.ok(!JSON.stringify(r).includes('provider-secret'), 'the credential never comes back');
  const chatty = await proxy(t, { fetch: async () => new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'session=1', 'x-provider-request': 'abc', 'x-echo-key': 'provider-secret' } }) });
  const answered = await send(chatty.p.url);
  assert.equal(answered.headers['content-type'], 'text/event-stream');
  for (const name of ['set-cookie', 'x-provider-request', 'x-echo-key']) assert.equal(answered.headers[name], undefined, name);
  assert.ok(!JSON.stringify(answered.headers).includes('provider-secret'));
});

test('a duplicate key at any depth, a second JSON value, bad UTF-8 or a policy refusal is refused before anything is asked', async (t) => {
  const { p, forwarded, hooks } = await proxy(t);
  for (const body of ['{"model":"a","model":"b"}', '{"input":[{"a":1,"a":2}]}', '{"model":"a"} {}', '[1]', '{"model":', '"text"']) {
    assert.equal((await send(p.url, { body })).status, 400, body);
  }
  assert.equal((await send(p.url, { body: { tools: [{ type: 'hosted' }] } })).status, 403);
  assert.throws(() => parseStrict('{"a":{"b":1,"b":2}}'), /appears twice/);
  assert.equal(hooks.before.length + forwarded.length, 0);
});

test('a request the runner refuses is never forwarded, and answers a status the client does not retry', async (t) => {
  const { p, forwarded, hooks } = await proxy(t, { refuse: 'turn_limit' });
  const r = await send(p.url);
  assert.equal(r.status, 400);
  assert.match(r.text, /turn_limit/);
  assert.deepEqual([forwarded.length, hooks.after.length, hooks.before], [0, 0, [{ model: 'session-model' }]]);
  const own = await proxy(t, { refuse: 'budget', policy: { ...policy, refusedStatus: 403 } });
  assert.equal((await send(own.p.url)).status, 403);
});

test('usage comes back once a response completes; a cut stream reports nothing; an error answer costs nothing; no credential is a 500', async (t) => {
  const done = await proxy(t);
  await send(done.p.url);
  assert.deepEqual(done.hooks.after, [{ input: 7, output: 2, cacheRead: 0, usd: 0.001 }]);

  const cut = await proxy(t, { fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n')); c.error(new Error('cut')); } }), { status: 200 }) });
  await send(cut.p.url).catch(() => {});
  assert.deepEqual([cut.hooks.before.length, cut.hooks.after.length], [1, 0]);

  const failed = await proxy(t, { fetch: async () => new Response('{"error":"overloaded"}', { status: 529 }) });
  assert.equal((await send(failed.p.url)).status, 529);
  assert.deepEqual(failed.hooks.after, [{ input: 0, output: 0, cacheRead: 0, usd: 0 }]);

  const none = await proxy(t, { credential: () => '' });
  assert.equal((await send(none.p.url)).status, 500);
  assert.equal(none.forwarded.length, 0);
});

test("a long answer's usage is read from both ends: input reported as it starts, output as it ends", async (t) => {
  const split = { ...policy, usageOf(text) {
    const input = [...text.matchAll(/"start":\{"in":(\d+)\}/g)].at(-1);
    const output = [...text.matchAll(/"end":\{"out":(\d+)\}/g)].at(-1);
    return input && output ? { input: Number(input[1]), output: Number(output[1]), cacheRead: 0 } : undefined;
  } };
  const middle = `data: {"delta":"${'x'.repeat(200 * 1024)}"}\n\n`;
  const long = await proxy(t, { policy: split, fetch: async () => new Response(`data: {"start":{"in":1200}}\n\n${middle}data: {"end":{"out":340}}\n\n`, { status: 200 }) });
  assert.equal((await send(long.p.url)).status, 200);
  assert.deepEqual(long.hooks.after, [{ input: 1200, output: 340, cacheRead: 0, usd: 0.001 }]);
});

test('waitForSubmissions returns the pending input once it is submitted, and [] once stopped', async () => {
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open('s'), signal: new AbortController().signal });
  const waiting = waitForSubmissions(drive, { pollMs: 5_000 });
  await drive.submit({ id: 'p1', kind: 'prompt', text: 'go' });
  assert.deepEqual((await waiting).map((s) => s.id), ['p1'], 'the hint wakes it before the poll');
  const stop = new AbortController();
  const idle = await openDrive({ writer: await store.open('t'), signal: new AbortController().signal });
  const stopped = waitForSubmissions(idle, { signal: stop.signal, pollMs: 5_000 });
  stop.abort();
  assert.deepEqual(await stopped, []);
});

test('zodShapeFromJsonSchema builds the tool shape from a JSON Schema, with the zod it is given', () => {
  const shape = zodShapeFromJsonSchema({ type: 'object', properties: { path: { type: 'string' }, lines: { type: 'integer' }, mode: { enum: ['a', 'b'] } }, required: ['path'] }, z);
  const schema = z.object(shape);
  assert.deepEqual(schema.parse({ path: 'x', mode: 'a' }), { path: 'x', mode: 'a' });
  assert.throws(() => schema.parse({ lines: 1 }));
  assert.throws(() => schema.parse({ path: 'x', mode: 'c' }));
});
