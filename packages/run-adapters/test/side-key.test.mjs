// One route for every model request of a session (fix 5): a request the host sends beside the harness's own (a learned
// workflow's model node, its `llm` call node, its native search) goes through the session's own model proxy, on the same
// policy, origin, credential, price and booking, under a side key the proxy mints for it. The harness holds only the
// session's key, so it can't label its own requests. A side request is labelled in the booking (its runner.request
// record and its events), is never the turn's answer request (a content-filter stop on it never halts the turn) and is
// never watched by the policy. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { modelPortFor, RUNNER_RECORDS } from '@parcha/agentrun-kernel';
import { startModelProxy } from '@parcha/agentrun-kernel/host';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const KEY = 'session-key-for-tests';
const LABEL = 'learned_workflow';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: (text) => (text.includes('"end":true') ? { input: 7, output: 2, cacheRead: 0 } : undefined),
};
/** The provider: every answer ends with its usage; one whose body says `refuse` stops on the content filter first. */
const provider = (seen = []) => async (url, init) => {
  seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body)) });
  const body = JSON.parse(String(init.body));
  const text = `${body.refuse ? 'data: {"stop":"refusal"}\n\n' : ''}data: {"end":true}\n\n`;
  return new Response(encoder.encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
/** One POST through the proxy with `key`: its status and text. */
const post = (url, key, body = {}) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(url);
  const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});

test('a side key the proxy mints is not the session key, and a request under it reaches the same provider with the same credential, labelled in its admission', { timeout: 30_000 }, async (t) => {
  const asked = [];
  const seen = [];
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async (request) => { asked.push(request); }, afterRequest: async () => {} }, fetch: provider(seen),
  }, KEY);
  t.after(() => p.close());
  assert.equal(typeof p.sideKey, 'function', 'the proxy mints a side key for requests the host sends beside the harness');
  const side = p.sideKey(LABEL);
  assert.equal(typeof side, 'string');
  assert.ok(side.length >= 32, 'a random key, as long as the session key is');
  assert.notEqual(side, KEY, 'not the session key: the harness holds only that one');
  assert.equal(p.sideKey(LABEL), side, 'one key per label');
  assert.equal((await post(p.url, KEY)).status, 200);
  assert.equal((await post(p.url, side)).status, 200);
  assert.notEqual((await post(p.url, 'a-key-nobody-minted')).status, 200, 'any other key is refused');
  assert.deepEqual(asked.map((r) => r.host), [undefined, LABEL], 'only the side request is labelled');
  assert.deepEqual(seen.map((s) => [s.url, s.headers.authorization]), [['https://provider.invalid/v1/test', 'Bearer provider-secret'], ['https://provider.invalid/v1/test', 'Bearer provider-secret']], 'the same provider, with the same credential');
});

test("a side request is never the turn's answer: its content-filter stop never halts the turn, and the policy never watches it", { timeout: 30_000 }, async (t) => {
  const told = [];
  let watched = 0;
  const watching = { ...policy, filtered: (text) => text.includes('"stop":"refusal"'), watch: () => { watched += 1; return { chunk() {} }; } };
  const p = await startModelProxy({
    policy: watching, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, fetch: provider(), onFiltered: (message) => { told.push(message); },
  }, KEY);
  t.after(() => p.close());
  assert.equal(typeof p.sideKey, 'function', 'the proxy mints a side key');
  await post(p.url, p.sideKey(LABEL), { refuse: true });
  await sleep(100);
  assert.deepEqual([told.length, watched], [0, 0], "a side request's filter stop is not the turn's, and the policy did not watch it");
  await post(p.url, KEY, { refuse: true });
  for (const end = Date.now() + 5_000; !told.length; await sleep(20)) assert.ok(Date.now() < end, "the session's own request still halts on its stop");
  assert.equal(watched, 1, "the session's own request is watched, as before");
});

test("the booking keeps a side request's label: its runner.request record and its events say it, and it counts in the session's one spend", { timeout: 30_000 }, async (t) => {
  const store = memorySessionStore();
  const events = [];
  const booking = await modelPortFor(await store.open('run:a'), { key: 'run:a', onEvent: (event) => events.push(event) });
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: booking.models, price: () => 0.002, log: () => {}, fetch: provider() }, KEY);
  t.after(() => p.close());
  assert.equal(typeof p.sideKey, 'function', 'the proxy mints a side key');
  await post(p.url, KEY);
  await post(p.url, p.sideKey(LABEL));
  for (let i = 0; i < 200 && (await store.read('run:a')).filter((r) => r.kind === RUNNER_RECORDS.turn).length < 2; i++) await sleep(10);
  const requests = (await store.read('run:a')).filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => r.data);
  assert.deepEqual(requests.map((r) => r.host), [undefined, LABEL], `labelled on its record: ${JSON.stringify(requests)}`);
  assert.deepEqual(events.filter((e) => e.type === 'request_start').map((e) => e.host), [undefined, LABEL], 'labelled on its start');
  assert.deepEqual(events.filter((e) => e.type === 'request_end').map((e) => e.host), [undefined, LABEL], 'labelled on its end');
  assert.equal(booking.spentUsd(), 0.004, 'both in the one spend');
  assert.equal(booking.turns(), 2, 'both counted as the session\'s requests');
});

test("a side key opens the model routes only: the session's MCP door at /mcp/<server> stays behind the session's key", { timeout: 30_000 }, async (t) => {
  const mcp = { servers: [{ name: 'fake', tools: [{ name: 'add', description: 'Adds.', inputSchema: { type: 'object' } }] }], call: async () => ({ content: [{ type: 'text', text: 'ran' }] }) };
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, fetch: provider(), mcp: { session: mcp, client: { callIdMeta: 'claudecode/toolUseId' } },
  }, KEY);
  t.after(() => p.close());
  assert.equal(typeof p.sideKey, 'function', 'the proxy mints a side key');
  const list = (key) => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(p.url);
    const req = request({ host: hostname, port, method: 'POST', path: '/mcp/fake', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
  assert.equal(await list(KEY), 200, "the session's key opens its MCP door");
  assert.equal(await list(p.sideKey(LABEL)), 401, 'a side key does not');
});
