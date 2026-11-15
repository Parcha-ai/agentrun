// A request on a model whose known price is $0 for every token (a free model) costs nothing, however it ends: one that
// fails after it left, is retried or is cut books a known $0, marked `free`, never an unknown cost. A model with no
// known price keeps the rule that a request with no cost of its own is unknown, never $0; a paid model is unchanged.
// Through the run's one cap (runCap, uncapped and capped), the runner's booking and the model proxy. No network: the
// provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { modelPortFor, RUNNER_RECORDS, sessionSpendOf } from '@parcha/agentrun-kernel';
import { startModelProxy } from '@parcha/agentrun-kernel/host';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { runCap } from '../dist/kernel/cap/index.js';
import { FREE, SONNET, UNPRICED } from './kernel-cap-support.mjs';

const KEY = 'session-key-for-tests';
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: (text) => (/"usage":\{"in":(\d+),"out":(\d+)\}/.exec(text) ? { input: 7, output: 2, cacheRead: 0 } : undefined),
};
/** An answer whose body starts, then fails: it left, and no cost came back (booked lost). */
const cut = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n')); c.error(new Error('cut')); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
/** A reset once the request left: no answer at all (booked lost). */
const reset = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) }); };
/** A whole answer with its usage. */
const whole = async () => new Response('{"usage":{"in":7,"out":2}}', { status: 200, headers: { 'content-type': 'application/json' } });

/** The price each model's route books an answer at, as serve's route prices it: a free model's $0, a paid one's figure,
 *  none for a model with no price. */
const priceOf = { [FREE.id]: () => 0, [SONNET.id]: () => 0.001, [UNPRICED.id]: () => null };

/** One request on `model` through the proxy into the runner's booking, admitted by the run's one cap (no cap: the proxy's
 *  test policy cannot write an output limit into a body, so a capped request is never sent) with `fetch` as the
 *  provider: the session's runner.turn and its cost as sessionSpendOf reads it. */
async function booked(t, model, fetch) {
  const store = memorySessionStore();
  const cap = runCap({ sessions: store, capUsd: () => undefined, modelOf: () => model });
  const booking = await modelPortFor(await store.open('chat:b'), { key: 'chat:b', beforeRequest: cap.before });
  const p = await startModelProxy({ policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: booking.models, price: priceOf[model.id], log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  await new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end('{}');
  });
  for (let i = 0; i < 200 && !(await store.read('chat:b')).some((r) => r.kind === RUNNER_RECORDS.turn); i++) await new Promise((r) => setTimeout(r, 10));
  return readBack(store, booking);
}

/** One request on `model` admitted by the run's one cap at `capUsd` and ended as `ended` with no cost of its own, booked
 *  straight through the runner's booking (as a CLI's proxy books one). */
async function bookedUnder(model, capUsd, ended) {
  const store = memorySessionStore();
  const cap = runCap({ sessions: store, capUsd: () => capUsd, modelOf: () => model });
  const booking = await modelPortFor(await store.open('chat:b'), { key: 'chat:b', beforeRequest: cap.before });
  const ticket = await booking.models.beforeRequest({ model: model.id, inputTokensMax: 1_000, outputTokensAsked: 1_024, outputTokensLeast: 1_024 });
  await booking.models.afterRequest({ input: 0, output: 0, cacheRead: 0, usd: null }, ticket || undefined, ended);
  return readBack(store, booking);
}

/** The session's runner.turn, its cost as sessionSpendOf reads it, and what the booking counts for the cap. */
async function readBack(store, booking) {
  const records = await store.read('chat:b');
  const turn = records.find((r) => r.kind === RUNNER_RECORDS.turn)?.data;
  return { turn, cost: sessionSpendOf(records).cost, spentUsd: booking.spentUsd() };
}

const KNOWN_ZERO = { usd: 0, soFarUsd: 0, unpriced: 0 };

for (const [how, fetch] of [['cut part way', cut], ['reset once it left', reset]]) {
  test(`a free model's request ${how} books a known $0, marked free, never an unknown cost`, async (t) => {
    const { turn, cost, spentUsd } = await booked(t, FREE, fetch);
    assert.equal(turn?.free, true, `its booking says the model is free: ${JSON.stringify(turn)}`);
    assert.deepEqual([turn?.usd, turn?.bookedUsd], [0, 0], `its own cost and its booked figure are $0: ${JSON.stringify(turn)}`);
    assert.deepEqual(cost, KNOWN_ZERO, "the session's cost is a known $0");
    assert.equal(spentUsd, 0, 'the cap counts it at $0');
  });
}

test("under a cap, a free model's request that failed, was retried, cut or stopped books a known $0, marked free", async () => {
  for (const ended of [{ end: 'lost', label: 'error_after', began: true }, { end: 'lost', label: 'retried' }, { end: 'lost', label: 'cut' }, { end: 'stopped', streamedTokens: 10 }, { end: 'answered', usd: null }]) {
    const { turn, cost, spentUsd } = await bookedUnder(FREE, 1, ended);
    assert.deepEqual([turn?.usd, turn?.bookedUsd, turn?.free], [0, 0, true], `${JSON.stringify(ended)}: ${JSON.stringify(turn)}`);
    assert.deepEqual(cost, KNOWN_ZERO, `${JSON.stringify(ended)}: a known $0`);
    assert.equal(spentUsd, 0);
  }
});

test("a guard: a request billed to a plan (listed at $0, paid by the plan) is never free: no price here, as before", async () => {
  const store = memorySessionStore();
  const cap = runCap({ sessions: store, capUsd: () => undefined, modelOf: () => FREE });
  const booking = await modelPortFor(await store.open('chat:b'), { key: 'chat:b', beforeRequest: cap.before });
  const ticket = await booking.models.beforeRequest({ model: FREE.id, inputTokensMax: 1_000, outputTokensAsked: 1_024, outputTokensLeast: 1_024 });
  await booking.models.afterRequest({ input: 10, output: 2, cacheRead: 0, usd: null, billing: 'plan' }, ticket || undefined, { end: 'lost', label: 'cut' });
  const plan = await readBack(store, booking);
  assert.deepEqual([plan.turn?.usd, plan.turn?.free, plan.turn?.billing], [null, undefined, 'plan'], `billed to the plan: ${JSON.stringify(plan.turn)}`);
});

test('a guard: under a cap, a paid model\'s request cut part way still counts at its hold for the cap, at a cost unknown, never free', async () => {
  const { turn, cost, spentUsd } = await bookedUnder(SONNET, 1, { end: 'lost', label: 'cut' });
  assert.deepEqual([turn?.usd, turn?.free], [null, undefined], JSON.stringify(turn));
  assert.ok(spentUsd > 0, `at its hold: ${spentUsd}`);
  assert.deepEqual([cost.usd, cost.unpriced], [null, 1]);
});

test("a free model's whole answer is a known $0, marked free", async (t) => {
  const { turn, cost } = await booked(t, FREE, whole);
  assert.deepEqual([turn?.usd, turn?.bookedUsd, turn?.free], [0, 0, true], JSON.stringify(turn));
  assert.deepEqual(cost, { usd: 0, soFarUsd: 0, unpriced: 0 });
});

test('a guard: a model with no known price keeps its rule: a request cut part way is a cost unknown, never $0, and never free', async (t) => {
  const { turn, cost } = await booked(t, UNPRICED, cut);
  assert.equal(turn?.free, undefined, JSON.stringify(turn));
  assert.equal(turn?.usd, null, 'its own cost is unknown');
  assert.deepEqual(cost, { usd: null, soFarUsd: 0, unpriced: 1 });
});

test('a guard: a paid model is unchanged: its answer at its price, its request cut part way a cost unknown, never free', async (t) => {
  const answered = await booked(t, SONNET, whole);
  assert.deepEqual([answered.turn?.usd, answered.turn?.free], [0.001, undefined], JSON.stringify(answered.turn));
  assert.deepEqual(answered.cost, { usd: 0.001, soFarUsd: 0.001, unpriced: 0 });
  const lost = await booked(t, SONNET, cut);
  assert.deepEqual([lost.turn?.usd, lost.turn?.free], [null, undefined], JSON.stringify(lost.turn));
  assert.deepEqual(lost.cost, { usd: null, soFarUsd: 0, unpriced: 1 });
});

test('a guard: a model whose price is partial (input or output missing) or $0 for one of them alone is never free: only $0 for both', async () => {
  for (const price of [{ input: 0 }, { output: 0 }, { input: 0, output: 1 }, { input: 1, output: 0 }, { input: 0, output: 0, tiers: [{ inputTokensAbove: 200_000, input: 1, output: 0 }] }]) {
    const model = { ...FREE, price };
    const cap = runCap({ sessions: memorySessionStore(), capUsd: () => undefined, modelOf: () => model });
    const verdict = await cap.before({ key: 'chat:b', label: 'chat:b', model: model.id, turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], inputTokensMax: 100 });
    assert.equal(verdict?.free, undefined, `${JSON.stringify(price)}: ${JSON.stringify(verdict)}`);
  }
});

test('a guard: a free model whose request carries a fee (a native web search) is not free: the fee is a cost', async () => {
  const store = memorySessionStore();
  const cap = runCap({ sessions: store, capUsd: () => undefined, modelOf: () => FREE });
  const verdict = await cap.before({ key: 'chat:b', label: 'chat:b', model: FREE.id, turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], inputTokensMax: 100, feeUsd: 0.01 });
  assert.equal(verdict?.free, undefined, JSON.stringify(verdict));
});
