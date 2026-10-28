// The provider-neutral model proxy, attacked from the side a harness sits on, under a test policy; and the copied
// layer's pieces a harness waits and builds tools with. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';
import { z } from 'zod';
import { hostHeaderProblems, matchRoute, parseStrict, ProxyRefusal, startModelProxy } from '@parcha/agentrun-adapters/host';
import { openDrive } from '@parcha/agentrun-adapters/kernel';
import { waitForSubmissions, zodShapeFromJsonSchema } from '@parcha/agentrun-adapters/process';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';

const KEY = 'session-key-for-tests';
/** A provider's rules, for the tests: one route, a bearer key, the model fixed, a `hosted` tool refused. */
const policy = {
  id: 'test',
  routes: [
    { method: 'POST', path: '/v1/test', query: ['beta=true'], headers: ['x-request-id', 'x-beta'] },
    { method: 'HEAD', path: '/v1/hello', local: 200 },
    { method: 'POST', path: '/v1/count', free: true },
  ],
  // A beta the policy knows passes; any other is dropped from the list, and an empty list drops the header.
  header: (name, value) => {
    if (name !== 'x-beta') return value;
    const known = value.split(',').map((v) => v.trim()).filter((v) => ['b1', 'b2'].includes(v));
    return known.length ? known.join(',') : undefined;
  },
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
  const hooks = { before: [], after: [], logged: [], responses: [] };
  const p = await startModelProxy({
    onResponse: extra.onResponse ?? ((r) => hooks.responses.push(r)),
    log: extra.log ?? ((message, detail) => hooks.logged.push({ message, ...detail })),
    policy: extra.policy ?? policy,
    model: 'session-model',
    origin: 'https://provider.invalid/ignored/path',
    credential: extra.credential ?? (() => 'provider-secret'),
    hooks: { beforeRequest: async (r) => { hooks.before.push(r); if (extra.refuse) throw new Error(extra.refuse); }, afterRequest: async (u) => { hooks.after.push(u); if (extra.afterThrows) throw new Error(extra.afterThrows); } },
    price: extra.price ?? (() => 0.001),
    ...(extra.headers ? { headers: extra.headers } : {}),
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
  const { p, forwarded, hooks } = await proxy(t);
  const refused = ['http://evil.example/v1/test', '//evil.example/v1/test', '/v1/test/../files', '/v1/%74est', '/v1/test?x=1', '/v1/files', '/v1/test/', '/v1//test', '/V1/test'];
  for (const path of refused) assert.equal((await send(p.url, { path })).status, 403, path);
  for (const method of ['GET', 'PUT']) assert.equal((await send(p.url, { method })).status, 403, method);
  assert.equal(forwarded.length, 0, 'nothing refused reached the provider');
  // Every refusal is reported, with what was asked: a client calling a route the table lacks is seen.
  const refusals = hooks.logged.filter((l) => /refused/.test(l.message));
  assert.equal(refusals.length, refused.length + 2);
  assert.deepEqual(refusals.at(-1), { message: 'model proxy (test): refused', status: 403, method: 'PUT', path: '/v1/test', reason: 'PUT /v1/test is not in the table' });
  assert.ok(refusals.some((l) => l.path === '/v1/files' && l.method === 'POST'));
  assert.ok(!JSON.stringify(hooks.logged).includes(KEY), 'a report never carries the session key');
  assert.throws(() => matchRoute(policy.routes, 'POST', 'v1/test'), /not one the table can match/);
  // A query the route lists exactly passes, and is forwarded as the table has it; any other is refused.
  for (const path of ['/v1/test?beta=false', '/v1/test?beta=true&x=1', '/v1/test?beta=true?', '/v1/count?beta=true']) assert.equal((await send(p.url, { path })).status, 403, path);
  assert.equal(forwarded.length, 0);
  assert.equal((await send(p.url, { path: '/v1/test?beta=true' })).status, 200);
  assert.equal(forwarded[0].url, 'https://provider.invalid/v1/test?beta=true');
});

test("a local route is answered by the proxy with its status alone, with or without the key, and nothing is forwarded or asked", async (t) => {
  const { p, forwarded, hooks } = await proxy(t);
  // A client's connectivity check carries no key (the Claude Agent CLI's does not): it learns only that the proxy is up.
  for (const key of [null, 'wrong', KEY]) {
    const hello = await send(p.url, { method: 'HEAD', path: '/v1/hello', key, body: '' });
    assert.deepEqual([hello.status, hello.text, hello.headers['content-length']], [200, '', '0'], `key ${key}`);
  }
  assert.deepEqual([forwarded.length, hooks.before.length, hooks.after.length], [0, 0, 0]);
  // Every other route still needs it, a free one too; and without it a path the table lacks gets the same 401, so
  // the table can't be mapped without the key.
  assert.equal((await send(p.url, { path: '/v1/count', key: null })).status, 401);
  for (const path of ['/v1/files', '/v1/test?x=1', '/../etc']) assert.equal((await send(p.url, { path, key: null })).status, 401, path);
  assert.equal(forwarded.length, 0);
});

test("a provider that does not serve a free route answers it as it does (a 404 passes through), no turn is counted, and the status is told", async (t) => {
  const { p, forwarded, hooks } = await proxy(t, { fetch: async (url) => (url.endsWith('/v1/count') ? new Response('{"error":"not found"}', { status: 404 }) : new Response(sse(), { status: 200 })) });
  const counted = await send(p.url, { path: '/v1/count' });
  assert.equal(counted.status, 404);
  assert.deepEqual([hooks.before.length, hooks.after.length], [0, 0]);
  await send(p.url);
  assert.deepEqual(hooks.responses, [{ method: 'POST', path: '/v1/count', free: true, status: 404 }, { method: 'POST', path: '/v1/test', free: false, status: 200 }]);
  assert.equal(forwarded.length, 0, 'this test forwards through its own fetch');
});

test("an onResponse that throws loses neither the provider's answer nor its booking", async (t) => {
  const { p, hooks } = await proxy(t, { onResponse: () => { throw new Error('a host bug'); } });
  const r = await send(p.url);
  assert.equal(r.status, 200);
  assert.match(r.text, /"done":true/);
  assert.deepEqual(hooks.after, [{ input: 7, output: 2, cacheRead: 0, usd: 0.001 }], 'the paid request is booked once');
  assert.ok(hooks.logged.some((l) => /onResponse threw/.test(l.message) && /a host bug/.test(l.error)));
});

test("no host callback that runs after a paid answer can turn it into an error or lose its booking", async (t) => {
  // A log that throws, beside an onResponse that throws: the answer and its booking go on.
  const noisy = await proxy(t, { onResponse: () => { throw new Error('host bug'); }, log: () => { throw new Error('log bug'); } });
  assert.equal((await send(noisy.p.url)).status, 200);
  assert.deepEqual(noisy.hooks.after, [{ input: 7, output: 2, cacheRead: 0, usd: 0.001 }]);
  // A policy that cannot read the usage, or a price that throws: booked once, at an unknown cost.
  const unreadable = await proxy(t, { policy: { ...policy, usageOf: () => { throw new Error('policy bug'); } } });
  const answer = await send(unreadable.p.url);
  assert.deepEqual([answer.status, /"done":true/.test(answer.text)], [200, true]);
  assert.deepEqual(unreadable.hooks.after, [{ input: 0, output: 0, cacheRead: 0, usd: null, estimated: true }]);
  const unpriced = await proxy(t, { price: () => { throw new Error('price bug'); } });
  assert.equal((await send(unpriced.p.url)).status, 200);
  assert.deepEqual(unpriced.hooks.after, [{ input: 7, output: 2, cacheRead: 0, usd: null, estimated: true }]);
  // A booking that fails: the client still has the whole answer, and the failure is reported, not a 502.
  const unbooked = await proxy(t, { afterThrows: 'store down' });
  const kept = await send(unbooked.p.url);
  assert.deepEqual([kept.status, /"done":true/.test(kept.text)], [200, true]);
  assert.equal(unbooked.hooks.after.length, 1);
  assert.ok(unbooked.hooks.logged.some((l) => /afterRequest threw/.test(l.message) && /store down/.test(l.error)));
  assert.ok(!unbooked.hooks.logged.some((l) => /did not complete/.test(l.message)));
});

test('a free route is forwarded without asking the runner, and reports no usage', async (t) => {
  const { p, forwarded, hooks } = await proxy(t, { refuse: 'turn_limit' });
  assert.equal((await send(p.url, { path: '/v1/count' })).status, 200, 'the runner refusing paid requests does not refuse a free one');
  assert.deepEqual([forwarded.length, hooks.before.length, hooks.after.length], [1, 0, 0]);
  // Free is not unchecked: the body is still the policy's (the client asked for another model), and one it refuses is refused.
  assert.equal(forwarded[0].body.model, 'session-model');
  assert.equal((await send(p.url, { path: '/v1/count', body: { model: 'other', tools: [{ type: 'hosted' }] } })).status, 403);
  assert.equal(forwarded.length, 1);
});

test("a listed header's value is the policy's: unknown betas are dropped, and none left drops the header", async (t) => {
  const { p, forwarded } = await proxy(t);
  await send(p.url, { headers: { 'x-beta': 'b1, evil, b2' } });
  await send(p.url, { headers: { 'x-beta': 'evil' } });
  assert.equal(forwarded[0].headers['x-beta'], 'b1,b2');
  assert.equal(forwarded[1].headers['x-beta'], undefined);
  // A policy that refuses an unknown value refuses the request, before the runner is asked.
  const strict = await proxy(t, { policy: { ...policy, header: (name, value) => { if (name === 'x-beta' && value !== 'b1') throw new ProxyRefusal(403, `the beta ${value} is not listed`); return value; } } });
  const refused = await send(strict.p.url, { headers: { 'x-beta': 'evil' } });
  assert.deepEqual([refused.status, strict.forwarded.length, strict.hooks.before.length], [403, 0, 0]);
  assert.match(refused.text, /not listed/);
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

test('every paid request forwarded is booked once: its usage when it says it; an unknown cost when cut short, silent or unreachable; nothing for an error answer; no credential is a 500', async (t) => {
  const done = await proxy(t);
  await send(done.p.url);
  assert.deepEqual(done.hooks.after, [{ input: 7, output: 2, cacheRead: 0, usd: 0.001 }]);

  const cut = await proxy(t, { fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n')); c.error(new Error('cut')); } }), { status: 200 }) });
  await send(cut.p.url).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([cut.hooks.before.length, cut.hooks.after], [1, [{ input: 0, output: 0, cacheRead: 0, usd: null, estimated: true }]], 'a stream cut mid-body');

  const silent = await proxy(t, { fetch: async () => new Response('data: {"delta":"hi"}\n\n', { status: 200 }) });
  assert.equal((await send(silent.p.url)).status, 200);
  assert.deepEqual(silent.hooks.after, [{ input: 0, output: 0, cacheRead: 0, usd: null, estimated: true }], 'an answer that says no usage');

  const unreachable = await proxy(t, { fetch: async () => { throw new Error('connection reset'); } });
  assert.equal((await send(unreachable.p.url)).status, 502);
  assert.deepEqual(unreachable.hooks.after, [{ input: 0, output: 0, cacheRead: 0, usd: null, estimated: true }], 'a forward that failed may still have been paid');

  const failed = await proxy(t, { fetch: async () => new Response('{"error":"overloaded"}', { status: 529 }) });
  assert.equal((await send(failed.p.url)).status, 529);
  assert.deepEqual(failed.hooks.after, [{ input: 0, output: 0, cacheRead: 0, usd: 0 }]);

  // A request that could not be sent (no credential, one that could not be read, or headers the policy could not build)
  // is refused before the runner is asked: never admitted, never booked, no turn spent.
  for (const extra of [{ credential: () => '' }, { credential: () => { throw new Error('vault down'); } }, { policy: { ...policy, authHeaders: () => { throw new Error('policy bug'); } } }]) {
    const none = await proxy(t, extra);
    assert.equal((await send(none.p.url, { path: '/v1/test?beta=true' })).status, 500);
    assert.deepEqual([none.forwarded.length, none.hooks.before.length, none.hooks.after.length], [0, 0, 0]);
  }
});

test("a client that hangs up once it has read the usage the provider reported (the stream still open) is booked at that usage, and a hang-up before any usage at an unknown cost", async (t) => {
  // The provider sends its usage and then holds the stream open until the proxy aborts it; the client leaves at once.
  const holding = (text) => async (_url, init) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); init.signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const hangUp = (url, seen) => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify({ model: 'other', input: 'hi' }));
    setTimeout(() => reject(new Error(`no answer arrived ${seen}`)), 5_000).unref();
  });
  const settled = async (hooks) => { for (let i = 0; i < 100 && hooks.after.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };

  const reported = await proxy(t, { fetch: holding(sse({ in: 11, out: 4 })) });
  await hangUp(reported.p.url, 'with usage');
  await settled(reported.hooks);
  assert.deepEqual(reported.hooks.after, [{ input: 11, output: 4, cacheRead: 0, usd: 0.001 }], 'the usage the provider reported is booked');

  const silent = await proxy(t, { fetch: holding('data: {"delta":"hi"}\n\n') });
  await hangUp(silent.p.url, 'without usage');
  await settled(silent.hooks);
  assert.deepEqual(silent.hooks.after, [{ input: 0, output: 0, cacheRead: 0, usd: null, estimated: true }], 'no usage seen: an unknown cost');
});

test('close() while a request waits for the runner: it is not sent, and it is released, booked once at nothing', async (t) => {
  let admit;
  const waiting = new Promise((resolve) => { admit = resolve; });
  const forwarded = [];
  const after = [];
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: { beforeRequest: () => waiting, afterRequest: async (u) => { after.push(u); } }, fetch: async (url, init) => { forwarded.push(url); return new Response(sse()); } }, KEY);
  const answer = send(p.url, { path: '/v1/test?beta=true' }).catch((error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const closing = p.close();
  admit();
  await closing;
  await answer;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(forwarded, [], 'nothing is sent after close()');
  assert.deepEqual(after, [{ input: 0, output: 0, cacheRead: 0, usd: 0 }], 'the admitted request is released once');
});

test('nothing is admitted once close() has begun: a request still reading its credential then is refused, and the runner is never asked', async (t) => {
  let release;
  const reading = new Promise((resolve) => { release = resolve; });
  const before = [];
  const after = [];
  const forwarded = [];
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => reading.then(() => 'provider-secret'), hooks: { beforeRequest: async (r) => { before.push(r); }, afterRequest: async (u) => { after.push(u); } }, fetch: async (url) => { forwarded.push(url); return new Response(sse()); } }, KEY);
  const answer = send(p.url, { path: '/v1/test?beta=true' }).catch((error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const closing = p.close();
  release();
  await closing;
  await answer;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual([before.length, after.length, forwarded.length], [0, 0, 0], 'never admitted, never booked, never sent: no turn spent');
});

test('a "__proto__" key in a body is an own field: the parsed object keeps its prototype, and no other object is touched', () => {
  const parsed = parseStrict('{"__proto__":{"polluted":true},"a":1}');
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.ok(Object.hasOwn(parsed, '__proto__'));
  assert.deepEqual(parsed.__proto__, { polluted: true });
  assert.equal(parsed.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(JSON.stringify(parsed), '{"__proto__":{"polluted":true},"a":1}');
});

test("a client that reads slowly holds the provider back: the proxy reads no more of the answer until what it wrote drains", async (t) => {
  const CHUNK = 64 * 1024;
  const TOTAL = 1000;
  let pulled = 0;
  const body = new ReadableStream({ pull(controller) { if (pulled >= TOTAL) return controller.close(); pulled += 1; controller.enqueue(new Uint8Array(CHUNK).fill(120)); } }, { highWaterMark: 0 });
  const { p, hooks } = await proxy(t, { fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  // Each wait for the client to drain leaves nothing behind: a long answer that waits hundreds of times must not pile
  // listeners up on the response (Node warns past ten).
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const { hostname, port } = new URL(p.url);
  let received = 0;
  const done = new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test?beta=true', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      res.pause();
      setTimeout(() => {
        // Paused: the proxy has read only what the socket's buffers hold, not the whole answer.
        assert.ok(pulled < TOTAL / 2, `the proxy read ${pulled} of ${TOTAL} chunks for a client that read nothing`);
        res.on('data', (c) => { received += c.length; });
        res.on('end', resolve);
        res.resume();
      }, 300);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', input: 'hi' }));
  });
  await done;
  assert.equal(received, CHUNK * TOTAL, 'the whole answer reaches the client once it reads');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings.filter((name) => name === 'MaxListenersExceededWarning'), [], 'no listeners piled up on the response');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hooks.after.length, 1, 'booked once');
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

test("a request for the session's smaller model is asked about and priced as that model, not the session's", async (t) => {
  // A policy that lets a body name the session's small model, and says which model a checked body asks for.
  const small = { ...policy, apply: (body) => ({ ...body, model: body.model === 'small-model' ? 'small-model' : 'session-model' }), modelOf: (body) => body.model };
  const priced = [];
  const { p, hooks } = await proxy(t, { policy: small, price: (model, usage) => { priced.push(model); return model === 'small-model' ? 0.0001 : 0.001; } });
  assert.equal((await send(p.url, { path: '/v1/test?beta=true', body: { model: 'small-model', input: 'title' } })).status, 200);
  assert.equal((await send(p.url, { path: '/v1/test?beta=true', body: { model: 'big', input: 'work' } })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(hooks.before.map((r) => r.model), ['small-model', 'session-model']);
  assert.deepEqual(priced, ['small-model', 'session-model']);
  assert.deepEqual(hooks.after.map((u) => u.usd), [0.0001, 0.001]);
  // A policy without modelOf, or one that throws, books the session's model, as before.
  const throwing = await proxy(t, { policy: { ...small, modelOf: () => { throw new Error('policy bug'); } } });
  assert.equal((await send(throwing.p.url, { path: '/v1/test?beta=true', body: { model: 'small-model', input: 'title' } })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(throwing.hooks.before.map((r) => r.model), ['session-model']);
  assert.ok(throwing.hooks.logged.some((l) => /could not name the request's model/.test(l.message)));
});

test('two paid requests in flight through the proxy, answered in reverse: each is booked under its own turn, once', async (t) => {
  const { createHarnessRunner, modelPortFor, RUNNER_RECORDS } = await import('@parcha/agentrun-adapters');
  const { memorySessionStore } = await import('@parcha/agentrun-adapters/testing');
  const store = memorySessionStore();
  const ends = [];
  const booking = await modelPortFor(await store.open('chat:proxy'), { key: 'chat:proxy', onEvent: (e) => { if (e.type === 'request_end') ends.push([e.turn, e.usage.input]); } });
  // The slow request (admitted first) answers after the fast one: each answer reports its own size as input tokens.
  const slow = new Promise((resolve) => setTimeout(resolve, 150));
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.input === 'slow') await slow;
    return new Response(sse({ in: body.input === 'slow' ? 100 : 7, out: 1 }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: booking.models, price: () => 0.001, fetch: fetchStub }, KEY);
  t.after(() => p.close());
  const first = send(p.url, { path: '/v1/test?beta=true', body: { model: 'x', input: 'slow' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = send(p.url, { path: '/v1/test?beta=true', body: { model: 'x', input: 'fast' } });
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ends, [[2, 7], [1, 100]], 'the fast (turn 2) answer first, then the slow (turn 1), each under its own turn');
  const turns = (await store.read('chat:proxy')).filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data.turn);
  assert.deepEqual(turns, [2, 1]);
  void createHarnessRunner;
});

test("close() while one request is in flight and another waits on the runner: each is booked once, under its own turn", async () => {
  const { modelPortFor } = await import('@parcha/agentrun-adapters');
  const { memorySessionStore } = await import('@parcha/agentrun-adapters/testing');
  const ends = [];
  const booking = await modelPortFor(await memorySessionStore().open('chat:close'), { key: 'chat:close', onEvent: (e) => { if (e.type === 'request_end') ends.push([e.turn, e.usage.usd]); } });
  let admitSecond;
  const secondWaits = new Promise((resolve) => { admitSecond = resolve; });
  let n = 0;
  // The second request is admitted (its turn taken) and then waits, as a slow runner hook would, while close() begins.
  const hooks = { beforeRequest: async (r) => { const ticket = await booking.models.beforeRequest(r); if (++n === 2) await secondWaits; return ticket; }, afterRequest: (u, t) => booking.models.afterRequest(u, t) };
  // The first request's provider answer is still streaming when close() aborts it, and its teardown takes a moment, so it is
  // still in flight when the second is released.
  const fetchStub = async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 50), { once: true }));
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, fetch: fetchStub }, KEY);
  const first = send(p.url, { path: '/v1/test?beta=true' }).catch(() => {});
  while (n < 1) await new Promise((resolve) => setTimeout(resolve, 2));
  const second = send(p.url, { path: '/v1/test?beta=true' }).catch(() => {});
  while (n < 2) await new Promise((resolve) => setTimeout(resolve, 2));
  const closing = p.close();
  admitSecond();
  await closing;
  await Promise.all([first, second]);
  // Both bookings, the first after its teardown: bounded, never a fixed sleep.
  for (const end = Date.now() + 2000; ends.length < 2 && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ends.sort((a, b) => a[0] - b[0]), [[1, null], [2, 0]], 'turn 1 cut by the close (unknown), turn 2 released at nothing: each once, under its own turn');
});

test("each booked request carries the ids its response headers gave (a gateway's call id, the provider's request id), recorded when the headers arrive: a request a crash cut after them keeps them, one cut before them has none, and nothing else of the response is kept", async (t) => {
  const { modelPortFor, RUNNER_RECORDS } = await import('@parcha/agentrun-adapters');
  const { memorySessionStore } = await import('@parcha/agentrun-adapters/testing');
  const store = memorySessionStore();
  const key = 'chat:ids';
  const ends = [];
  const onEvent = (e) => { if (e.type === 'request_end') ends.push([e.turn, e.usage.providerIds ?? null, e.usage.cut ?? false]); };
  const booking = await modelPortFor(await store.open(key), { key, onEvent });
  // As a LiteLLM gateway answers: its own call id (what its spend log records), and the provider's request id passed on.
  const ids = (n) => ({ 'x-litellm-call-id': `7a6d0296-8607-4ead-bddd-ac09e92c6c3${n}`, 'request-id': `req_011CUa${n}` });
  // Headers that are not ids, or not id-shaped, and must never be kept.
  const noise = { 'content-type': 'text/event-stream', 'set-cookie': 'session=provider-secret', 'anthropic-organization-id': 'org-1', 'x-request-id': 'has space, not an id' };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const fetchStub = async (_url, init) => {
    const { input } = JSON.parse(init.body);
    if (input === 'answered') return new Response(sse(), { status: 200, headers: { ...noise, ...ids(1) } });
    // Its headers arrive, and the answer never ends: the provider saw it, and may bill it.
    if (input === 'cut-after-headers') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n')); } }), { status: 200, headers: { ...noise, ...ids(2) } });
    // No answer at all before the crash.
    await held;
    throw new Error('never answered');
  };
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: booking.models, price: () => 0.001, fetch: fetchStub }, KEY);
  t.after(async () => { release(); await p.close(); });
  await send(p.url, { path: '/v1/test?beta=true', body: { model: 'x', input: 'answered' } });
  send(p.url, { path: '/v1/test?beta=true', body: { model: 'x', input: 'cut-after-headers' } }).catch(() => {});
  send(p.url, { path: '/v1/test?beta=true', body: { model: 'x', input: 'cut-before-headers' } }).catch(() => {});
  const read = () => store.read(key);
  for (const end = Date.now() + 2_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 5))) {
    const records = await read();
    if (records.filter((r) => r.kind === RUNNER_RECORDS.request).length === 3 && records.some((r) => r.kind === RUNNER_RECORDS.response && r.data.turn === 2)) break;
  }
  // The crash: the next process books the two requests that never came back, once each.
  await (await modelPortFor(await store.open(key), { key, onEvent })).bookCut();
  const booked = (await read()).filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => [r.data.turn, r.data.providerIds ?? null, r.data.cut ?? false]);
  assert.deepEqual(booked, [[1, ids(1), false], [2, ids(2), true], [3, null, true]], 'answered with its ids; cut after the headers, with them (the provider saw it); cut before them, without');
  assert.deepEqual(ends, booked, 'request_end says the same');
  const text = JSON.stringify(await read());
  for (const kept of ['provider-secret', 'session=', 'org-1', 'has space']) assert.ok(!text.includes(kept), `${kept} is not in the records`);
});

test("two requests in flight, answered in reverse: each is booked with its own response's ids, under its own turn, never another's", async (t) => {
  const { modelPortFor, RUNNER_RECORDS } = await import('@parcha/agentrun-adapters');
  const { memorySessionStore } = await import('@parcha/agentrun-adapters/testing');
  const store = memorySessionStore();
  const key = 'chat:ids-overlap';
  const booking = await modelPortFor(await store.open(key), { key });
  // The provider's own id for each request, from its response: the slow (first admitted) request's arrives last.
  const slow = new Promise((resolve) => setTimeout(resolve, 150));
  const fetchStub = async (_url, init) => {
    const { input } = JSON.parse(init.body);
    if (input === 'slow') await slow;
    return new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': `req_${input}`, 'x-litellm-call-id': `call-${input}` } });
  };
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: booking.models, price: () => 0.001, fetch: fetchStub }, KEY);
  t.after(() => p.close());
  const first = send(p.url, { path: '/v1/test?beta=true', body: { model: 'x', input: 'slow' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = send(p.url, { path: '/v1/test?beta=true', body: { model: 'x', input: 'fast' } });
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const records = await store.read(key);
  const of = (kind) => records.filter((r) => r.kind === kind).map((r) => [r.data.turn, r.data.providerIds?.['request-id'], r.data.providerIds?.['x-litellm-call-id']]);
  assert.deepEqual(of(RUNNER_RECORDS.turn), [[2, 'req_fast', 'call-fast'], [1, 'req_slow', 'call-slow']], 'each turn has the ids its own response gave');
  assert.deepEqual(of(RUNNER_RECORDS.response), [[2, 'req_fast', 'call-fast'], [1, 'req_slow', 'call-slow']]);
});

test("the host's own headers go on every forwarded request, paid and free, over any the client sent by that name, and never the credential's", async (t) => {
  const tags = 'job:j1,purpose:research,run:r1';
  const { p, forwarded } = await proxy(t, { headers: { 'x-litellm-tags': tags, 'X-Beta': 'host-value' } });
  // The client's x-beta is one the route forwards and the policy keeps (b1), so it reaches the host's headers: the host's wins.
  assert.equal((await send(p.url, { path: '/v1/test?beta=true', headers: { 'x-beta': 'b1', 'x-litellm-tags': 'job:forged' } })).status, 200);
  assert.equal((await send(p.url, { path: '/v1/test?beta=true' })).status, 200);
  // A free route (count_tokens, on Anthropic's policy) is forwarded with them too.
  assert.equal((await send(p.url, { path: '/v1/count' })).status, 200);
  assert.equal(forwarded.length, 3);
  for (const { headers } of forwarded) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(lower['x-litellm-tags'], tags, 'the host\'s tags, never the client\'s');
    assert.equal(lower['x-beta'], 'host-value', 'the host\'s value over the client\'s, whatever its case');
    assert.equal(Object.keys(headers).filter((k) => k.toLowerCase() === 'x-beta').length, 1, 'one header by that name');
    assert.equal(lower.authorization, 'Bearer provider-secret', 'the credential is the proxy\'s own');
  }
  const { p: plain, forwarded: none } = await proxy(t);
  await send(plain.url, { path: '/v1/test?beta=true' });
  assert.equal(Object.keys(none[0].headers).some((k) => k.toLowerCase() === 'x-litellm-tags'), false, 'without host headers, none is added');
});

test("a host's header is checked when the proxy starts: a name that is a token and not the proxy's own, a one-line value", async () => {
  assert.deepEqual(hostHeaderProblems({ 'x-litellm-tags': 'job:1' }), []);
  for (const [headers, said] of [
    [{ Authorization: 'Bearer x' }, /the header Authorization is the proxy's own/],
    [{ 'x-api-key': 'k' }, /x-api-key is the proxy's own/],
    [{ 'anthropic-beta': 'b' }, /anthropic-beta is the proxy's own/],
    [{ 'bad name': 'v' }, /not a token/],
    [{ 'x-tags': 'a\r\nInjected: 1' }, /one line of text/],
    [{ 'x-tags': 'v'.repeat(1025) }, /at most 1024/],
  ]) assert.match(hostHeaderProblems(headers).join('; '), said, JSON.stringify(headers).slice(0, 60));
  await assert.rejects(startModelProxy({ policy, model: 'm', origin: 'https://x.invalid', credential: () => 'c', hooks: {}, headers: { host: 'evil' } }, KEY), /the header host is the proxy's own/);
});
