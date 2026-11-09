// Once the proxy has told the harness that the turn's answer stopped (the provider cut it at its output limit, or stopped
// it on its content filter), it refuses that session's next answer request with the policy's refusedStatus, unsent and
// unbooked, until the harness opens the next turn (ModelProxy.openTurn). So one paid request per stopped answer holds by
// construction, whatever a client that asks again does (Codex retries an incomplete stream), not only because the
// harness's interrupt beats its retry. A side request (the host's own key) is never refused for it. No network: the
// provider is a scripted fetch that counts what reaches it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';

const { startModelProxy } = host;
const KEY = 'session-key-for-tests';
const events = (text) => text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => { try { return JSON.parse(line.slice(6)); } catch { return undefined; } }).filter(Boolean);
/** A policy whose answers end `{ end, usage }`, a cut one `{ end, cut: true }`, a filtered one `{ stop: "refusal" }`. */
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: (text) => events(text).find((e) => e.end)?.usage,
  filtered: (text) => events(text).some((e) => e.stop === 'refusal'),
  cut: (text) => (events(text).some((e) => e.cut) ? { outputTokens: 3 } : undefined),
  refusedStatus: 422,
};
const USAGE = '"usage":{"input":12,"output":3,"cacheRead":0}';

/** A provider whose every answer is `line`, counting the requests that reach it. */
function provider(line) {
  const reached = [];
  const fetch = async (url) => {
    reached.push(String(url));
    return new Response(`data: ${line}\n\ndata: {"end":true,${USAGE}}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { reached, fetch };
}

async function start(t, line, told) {
  const booked = [];
  const p0 = provider(line);
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async (usage) => { booked.push(usage); } },
    fetch: p0.fetch,
    // The harness is told and does nothing: the client asks again at once, as Codex's retry does.
    onCut: () => told.push('cut'),
    onFiltered: () => told.push('filtered'),
  }, KEY);
  t.after(() => p.close());
  const send = async (key = KEY) => {
    const res = await fetch(`${p.url}/v1/test`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: '{}' });
    await res.text();
    return res.status;
  };
  return { p, send, booked, reached: p0.reached };
}

test('after a cut answer the next answer request is refused unsent and unbooked, until the harness opens the next turn', { timeout: 30_000 }, async (t) => {
  const told = [];
  const { p, send, booked, reached } = await start(t, '{"cut":true}', told);
  assert.equal(await send(), 200, 'the cut answer itself is passed');
  assert.deepEqual(told, ['cut']);
  assert.equal(await send(), 422, "the client's retry is refused with the policy's refusedStatus");
  assert.equal(await send(), 422, 'and again, however often it asks');
  assert.equal(reached.length, 1, 'one request reached the provider');
  assert.equal(booked.length, 1, 'one booked');
  p.openTurn();
  assert.equal(await send(), 200, 'the next turn asks again');
  assert.equal(reached.length, 2);
});

test('after a content-filter stop the next answer request is refused the same way', { timeout: 30_000 }, async (t) => {
  const told = [];
  const { p, send, reached } = await start(t, '{"stop":"refusal"}', told);
  assert.equal(await send(), 200);
  assert.deepEqual(told, ['filtered']);
  assert.equal(await send(), 422);
  assert.equal(reached.length, 1);
  p.openTurn();
  assert.equal(await send(), 200);
});

test("a side request (the host's own key) is never refused for the turn's stop", { timeout: 30_000 }, async (t) => {
  const told = [];
  const { p, send, reached } = await start(t, '{"cut":true}', told);
  assert.equal(await send(), 200);
  assert.equal(await send(p.sideKey('learned_workflow')), 200, "the host's own request goes on");
  assert.equal(reached.length, 2);
});

test('an answer that ended whole refuses nothing after it', { timeout: 30_000 }, async (t) => {
  const told = [];
  const { send, reached } = await start(t, '{"text":"ok"}', told);
  assert.equal(await send(), 200);
  assert.equal(await send(), 200);
  assert.deepEqual(told, []);
  assert.equal(reached.length, 2);
});
