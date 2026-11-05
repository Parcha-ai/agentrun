// One booking rule (booking.ts) for a request the model proxy forwards under a cap, through the runner's booking: never
// under-count. A gateway that gave up (504, 524) books the hold, since the provider was still at work. A request refused
// at connect never left: nothing. An error answer cut part way is still an error answer: nothing. Any other failure once
// the request left books the hold, and a later process reads the figure the first one booked, as written. No network:
// the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { modelPortFor, RUNNER_RECORDS } from '@parcha/agentrun-kernel';
import { startModelProxy } from '@parcha/agentrun-kernel/host';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const KEY = 'session-key-for-tests';
const HOLD = 0.25;
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: (text) => (/"usage":\{"in":(\d+),"out":(\d+)\}/.exec(text) ? { input: 7, output: 2, cacheRead: 0 } : undefined),
};
/** A fetch error as undici gives it: a TypeError with the socket's code on its cause. */
const refusedWith = (code) => async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }); };
/** A response whose body starts, then fails. */
const cut = (status) => async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n')); c.error(new Error('cut')); } }), { status, headers: { 'content-type': 'text/event-stream' } });

/** One request through the proxy into the runner's booking (holding HOLD for it), with `fetch` as the provider; the store,
 *  for a later process to read. */
async function booked(t, fetch, store = memorySessionStore()) {
  const booking = await modelPortFor(await store.open('chat:b'), { key: 'chat:b', beforeRequest: () => ({ holdUsd: HOLD }) });
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: booking.models, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  await new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end('{}');
  });
  for (let i = 0; i < 200 && !(await store.read('chat:b')).some((r) => r.kind === RUNNER_RECORDS.turn); i++) await new Promise((r) => setTimeout(r, 10));
  return { booking, store };
}
const later = async (store) => (await modelPortFor(await store.open('chat:b'), { key: 'chat:b', beforeRequest: () => ({ holdUsd: HOLD }) })).spentUsd();

test("a gateway's 504 or 524 books the hold: the provider was still at work when the gateway gave up, and bills it; a later process reads the same", async (t) => {
  for (const status of [504, 524]) {
    const { booking, store } = await booked(t, async () => new Response('upstream timed out', { status }));
    assert.equal(booking.spentUsd(), HOLD, `${status}: booked at the hold`);
    assert.equal(await later(store), HOLD, `${status}: read again at the hold`);
  }
});

test('a request refused at connect (ECONNREFUSED, ENOTFOUND, EHOSTUNREACH) never left: it books nothing', async (t) => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH']) {
    const { booking } = await booked(t, refusedWith(code));
    assert.equal(booking.spentUsd(), 0, `${code}: nothing`);
  }
});

test("an error answer whose body is cut part way is an error answer: it books nothing, as a whole one does", async (t) => {
  const { booking } = await booked(t, cut(500));
  assert.equal(booking.spentUsd(), 0);
});

test('a guard: a reset once the request left, an error answer, and an answer cut part way book as before (the hold, nothing, the hold)', async (t) => {
  assert.equal((await booked(t, refusedWith('ECONNRESET'))).booking.spentUsd(), HOLD, 'a reset: the hold');
  assert.equal((await booked(t, async () => new Response('slow down', { status: 429 }))).booking.spentUsd(), 0, 'a 429: nothing');
  assert.equal((await booked(t, cut(200))).booking.spentUsd(), HOLD, 'an answer cut part way: the hold');
});

test('a guard: a record from before the booking rule (no booked figure) is read as it always was', async () => {
  const store = memorySessionStore();
  const writer = await store.open('chat:b');
  await writer.append([{ kind: RUNNER_RECORDS.request, data: { turn: 1, model: 'm', heldUsd: HOLD } }, { kind: RUNNER_RECORDS.turn, data: { turn: 1, usd: null, input: 0, output: 0, cacheRead: 0 } }]);
  assert.equal(await later(store), HOLD, 'an unknown cost at its hold, as before');
});

/** The text of a server-sent event's data, as JSON (the content and reasoning readers below). */
const dataOf = (event) => JSON.parse(event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'));
/** A policy whose reasoning streams only as a summary: it says the body's hidden budget, and reads each event's content
 *  (summary and text) and its reasoning, never the framing around them. */
const HIDDEN = 2_000;
const summarized = {
  ...policy,
  reasoningHidden: () => HIDDEN,
  reasoningBytesOf: (event) => Buffer.byteLength(dataOf(event).summary ?? ''),
  contentBytesOf: (event) => { const data = dataOf(event); return Buffer.byteLength(data.summary ?? '') + Buffer.byteLength(data.text ?? ''); },
};

test("a request its client stops part way books what its content streamed and the part of its hidden reasoning budget its summary did not cover, max(0, budget - summary), as the proxy's stop fields say it, never the wire's bytes; a later process reads the same", async (t) => {
  const [summary, text] = ['Weighing the two readings', 'The answer so far: 思考'];
  const stream = Buffer.from(`event: summary\ndata: ${JSON.stringify({ id: 'resp_0123456789', sequence_number: 1, summary })}\n\nevent: text\ndata: ${JSON.stringify({ id: 'resp_0123456789', sequence_number: 2, text })}\n\n`);
  // What a stop counts at, as serve's cap counts it: what streamed and the 1,024-token allowance, at $10 a million.
  const stoppedUsd = (tokens) => (tokens + 1_024) * 10 / 1e6;
  const store = memorySessionStore();
  const booking = await modelPortFor(await store.open('chat:b'), { key: 'chat:b', beforeRequest: () => ({ holdUsd: HOLD, stoppedUsd }) });
  const p = await startModelProxy({ policy: summarized, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: booking.models, price: () => 0.001, log: () => {}, fetch: async (_url, init) => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(stream)); init.signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }) }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  await new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let read = 0;
      res.on('data', (chunk) => { read += chunk.length; if (read >= stream.length) { req.destroy(); resolve(); } });
      res.on('error', resolve);
      res.on('close', resolve);
    });
    req.on('error', resolve);
    req.end('{}');
  });
  for (let i = 0; i < 200 && !(await store.read('chat:b')).some((r) => r.kind === RUNNER_RECORDS.turn); i++) await new Promise((r) => setTimeout(r, 10));
  const content = Buffer.byteLength(summary) + Buffer.byteLength(text);
  const want = stoppedUsd(content + Math.max(0, HIDDEN - Buffer.byteLength(summary)));
  assert.ok(want < HOLD && stream.length !== content, 'the case tells the figures apart: within the hold, and the wire is not the content');
  assert.equal(Math.round(booking.spentUsd() * 1e9) / 1e9, Math.round(want * 1e9) / 1e9, "the stop's content and its unseen reasoning");
  assert.equal(Math.round((await later(store)) * 1e9) / 1e9, Math.round(want * 1e9) / 1e9, 'read again at the same figure');
});
