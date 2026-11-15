// What the provider says a request cost, read from its answer's own usage, and a refusal it sends inside a 200 stream.
// OpenRouter routes a request to one of a model's providers, often below the list price the catalog has (run 01a1ddee:
// $0.0147 at list, $0.0030 billed), and states what it charged in each answer's usage (`cost`, USD). A proxy told its
// upstream does so (`usageCost`) books that figure, the table's beside it. The cap still held the request at list before
// it left; a reported figure above that hold is not believed and the table's stands.
// OpenRouter (and Anthropic) answer 200 before the model's first token, so a rate limit, an overload or a failure after
// that comes as an error event inside the 200 stream. With no token reported before it, the request was refused and
// nothing was billed: $0, in the provider's words. With tokens reported, those tokens at list: a known figure.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { lastObjectOf, startModelProxy } from '@parcha/agentrun-kernel/host';
import { bookRequest, modelPortFor, RUNNER_RECORDS } from '@parcha/agentrun-kernel';
import * as testing from '@parcha/agentrun-kernel/testing';

const { memorySessionStore } = testing;
const usageCostOf = (text) => testing.usageCostOf(text);

const KEY = 'session-key-for-tests';
const SECRET = 'provider-secret-for-tests';
/** One route, a bearer key, and the usage read from the answer's last `usage` object (`in`, `out`). */
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf(text) {
    const usage = lastObjectOf(text, 'usage');
    return usage && typeof usage.in === 'number' ? { input: usage.in, output: usage.out, cacheRead: 0 } : undefined;
  },
};
// The table's figure at list for 90,000 input and 2,000 output tokens at $0.15 / $0.60 per million (gpt-oss-120b).
const LIST_USD = 0.0147;
const stream = (...events) => events.map((event) => `${event}\n\n`).join('');
const usageEvent = (usage) => `data: ${JSON.stringify({ choices: [], usage })}`;
const answering = (body, { contentType = 'text/event-stream', headers = {} } = {}) => async () => new Response(body, { status: 200, headers: { 'content-type': contentType, ...headers } });

async function proxy(t, { fetch, usageCost = true, hooks: given } = {}) {
  const after = [];
  const p = await startModelProxy({
    policy,
    model: 'session-model',
    origin: 'https://provider.invalid',
    credential: () => SECRET,
    hooks: given ?? { beforeRequest: async () => ({ turn: 1 }), afterRequest: async (usage, _ticket, ended) => void after.push({ usage, ended }) },
    price: () => LIST_USD,
    ...(usageCost ? { usageCost: true } : {}),
    fetch,
  }, KEY);
  t.after(() => p.close());
  return { p, after };
}

function send(url) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', input: 'hi' }));
  });
}

async function until(ready, what, ms = 5_000) {
  for (const end = Date.now() + ms; !(await ready()); await new Promise((resolve) => setTimeout(resolve, 2))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

test("OpenRouter's usage cost: a positive figure in USD, BYOK's upstream charge added, else unknown, never 0", () => {
  const of = (usage) => usageCostOf(stream(usageEvent(usage)));
  assert.equal(of({ in: 1, out: 1, cost: 0.003 }), 0.003);
  assert.equal(of({ in: 1, out: 1, cost: 0.003, is_byok: false }), 0.003);
  assert.equal(of({ cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.004 } }), 0.005, 'with your own key: OpenRouter\'s fee and the provider\'s charge');
  assert.equal(of({ cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: null, upstream_inference_prompt_cost: 0.003, upstream_inference_completions_cost: 0.001 } }), 0.005);
  assert.equal(of({ cost: 0.001, is_byok: true }), undefined, 'with your own key and no upstream charge, the whole is not known');
  for (const cost of [0, -0.003, '0.003', null, 1e9, Number.MAX_VALUE]) assert.equal(of({ in: 1, out: 1, cost }), undefined, String(cost));
  assert.equal(of({ in: 1, out: 1 }), undefined, 'no cost');
  assert.equal(usageCostOf('{"usage":{"cost":0.002}}'), 0.002, 'a whole JSON body');
  assert.equal(usageCostOf(stream('data: {"choices":[{"delta":{"content":"\\"usage\\": {\\"cost\\": 0.0001}"}}]}', usageEvent({ cost: 0.002 }))), 0.002, 'the answer\'s own usage, never a figure in its text');
  assert.equal(usageCostOf(stream('data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"cost":0.0042}}}')), 0.0042, 'a Responses stream\'s terminal event');
});

test("an answer whose upstream states its cost (OpenRouter) is booked at that figure, with the table's at list beside it", async (t) => {
  const { p, after } = await proxy(t, { fetch: answering(stream('data: {"choices":[{"delta":{"content":"hi"}}]}', usageEvent({ in: 90_000, out: 2_000, cost: 0.003, is_byok: false }), 'data: [DONE]')) });
  assert.equal((await send(p.url)).status, 200);
  await until(() => after.length === 1, 'the booking');
  assert.deepEqual(after[0].usage, { input: 90_000, output: 2_000, cacheRead: 0, usd: 0.003, tableUsd: LIST_USD });
  assert.deepEqual(after[0].ended, { end: 'answered', usd: 0.003, tableUsd: LIST_USD });
});

test("a whole JSON answer's usage cost is read too", async (t) => {
  const { p, after } = await proxy(t, { fetch: answering(JSON.stringify({ choices: [], usage: { in: 90_000, out: 2_000, cost: 0.003 } }), { contentType: 'application/json' }) });
  await send(p.url);
  await until(() => after.length === 1, 'the booking');
  assert.deepEqual(after[0].usage, { input: 90_000, output: 2_000, cacheRead: 0, usd: 0.003, tableUsd: LIST_USD });
});

test("a proxy not told its upstream states its cost never reads one: the table's figure, estimated", async (t) => {
  const { p, after } = await proxy(t, { usageCost: false, fetch: answering(stream(usageEvent({ in: 90_000, out: 2_000, cost: 0.003 }))) });
  await send(p.url);
  await until(() => after.length === 1, 'the booking');
  assert.deepEqual(after[0].usage, { input: 90_000, output: 2_000, cacheRead: 0, usd: LIST_USD, estimated: true });
});

test("a missing or insane usage cost falls back to the table's figure, estimated; a gateway's header still comes first", async (t) => {
  for (const cost of [undefined, 0, -1, '0.003', 5000]) {
    const { p, after } = await proxy(t, { fetch: answering(stream(usageEvent({ in: 90_000, out: 2_000, ...(cost === undefined ? {} : { cost }) }))) });
    await send(p.url);
    await until(() => after.length === 1, 'the booking');
    assert.deepEqual(after[0].usage, { input: 90_000, output: 2_000, cacheRead: 0, usd: LIST_USD, estimated: true }, String(cost));
  }
  const { p, after } = await proxy(t, { fetch: answering(stream(usageEvent({ in: 90_000, out: 2_000, cost: 0.003 })), { headers: { 'x-litellm-response-cost': '0.004' } }) });
  await send(p.url);
  await until(() => after.length === 1, 'the booking');
  assert.equal(after[0].usage.usd, 0.004, "the gateway's header first");
});

test("a reported figure above what the cap held is not believed: the table's figure is booked; within it, the reported one", () => {
  assert.deepEqual(bookRequest({ end: 'answered', usd: 0.003, tableUsd: LIST_USD }, { hold: 0.05 }), { usd: 0.003, rule: 'answered' });
  assert.deepEqual(bookRequest({ end: 'answered', usd: 0.08, tableUsd: LIST_USD }, { hold: 0.05 }), { usd: LIST_USD, rule: 'answered:over_hold' });
  assert.deepEqual(bookRequest({ end: 'answered', usd: 0.08, tableUsd: null }, { hold: 0.05 }), { usd: 0.05, rule: 'answered:over_hold' }, 'no table figure: the hold');
  assert.deepEqual(bookRequest({ end: 'answered', usd: 0.08, tableUsd: LIST_USD }, {}), { usd: 0.08, rule: 'answered' }, 'no cap, no hold to judge it by');
  assert.deepEqual(bookRequest({ end: 'answered', usd: 0.08 }, { hold: 0.05 }), { usd: 0.08, rule: 'answered' }, 'the table\'s own figure is not judged');
});

// The three skins OpenRouter answers on, each with its rate limit inside a 200 stream (OpenRouter's "Errors and Debugging":
// mid-stream errors), the provider's words echoing the key.
const LIMITED = `Rate limit exceeded: ${SECRET} free-models-per-min`;
const RATE_LIMITS = {
  'chat completions': stream(`data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', error: { code: 429, message: LIMITED, metadata: { error_type: 'rate_limit_exceeded' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })}`),
  messages: stream(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0}}}`, `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: LIMITED, error_type: 'rate_limit_exceeded' } })}`),
  responses: stream(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: LIMITED } } })}`),
};

for (const [skin, body] of Object.entries(RATE_LIMITS)) {
  test(`a rate limit inside a 200 stream (${skin}) is booked refused at $0, in the provider's words with the key cut`, async (t) => {
    const { p, after } = await proxy(t, { fetch: answering(body) });
    assert.equal((await send(p.url)).status, 200, 'the client has the stream as it came');
    await until(() => after.length === 1, 'the booking');
    assert.deepEqual(after[0].usage, { input: 0, output: 0, cacheRead: 0, usd: 0 });
    assert.deepEqual(after[0].ended, { end: 'nothing', label: 'refused', reason: 'Rate limit exceeded: [redacted] free-models-per-min' });
  });
}

// Any other error a provider writes inside its 200 stream (an overload, a failure) follows the one rule: what the stream
// reported before it is booked at list (or at the cost it stated); with nothing reported, refused at $0 in its words.
const FAILED = { error: { code: 502, message: `Provider disconnected: ${SECRET}` }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] };
const OVERLOADED = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}`;

test("any other error inside a 200 stream with nothing reported before it is refused at $0 too, in its words", async (t) => {
  for (const [body, reason] of [[stream(`data: ${JSON.stringify(FAILED)}`, 'data: [DONE]'), 'Provider disconnected: [redacted]'], [stream(OVERLOADED), 'Overloaded']]) {
    const { p, after } = await proxy(t, { fetch: answering(body) });
    await send(p.url);
    await until(() => after.length === 1, 'the booking');
    assert.deepEqual(after[0].usage, { input: 0, output: 0, cacheRead: 0, usd: 0 });
    assert.deepEqual(after[0].ended, { end: 'nothing', label: 'refused', reason });
  }
});

test("an error inside a 200 stream after the provider reported tokens books those tokens at list, a known figure with its words; never the hold", async (t) => {
  for (const failed of [`data: ${JSON.stringify(FAILED)}`, OVERLOADED]) {
    const { p, after } = await proxy(t, { fetch: answering(stream(usageEvent({ in: 90_000, out: 2_000 }), failed)) });
    await send(p.url);
    await until(() => after.length === 1, 'the booking');
    assert.deepEqual(after[0].usage, { input: 90_000, output: 2_000, cacheRead: 0, usd: LIST_USD, estimated: true });
    assert.equal(after[0].ended.end, 'answered');
    assert.equal(after[0].ended.label, 'error');
    assert.equal(after[0].ended.usd, LIST_USD);
    assert.match(after[0].ended.reason, /^(Provider disconnected: \[redacted\]|Overloaded)$/);
    assert.deepEqual(bookRequest(after[0].ended, { hold: 0.05 }), { usd: LIST_USD, rule: 'answered:error' });
  }
});

test("an error inside a 200 stream whose usage states what it cost books that figure (OpenRouter's), the list's beside it", async (t) => {
  const { p, after } = await proxy(t, { fetch: answering(stream(usageEvent({ in: 90_000, out: 2_000, cost: 0.003 }), `data: ${JSON.stringify(FAILED)}`)) });
  await send(p.url);
  await until(() => after.length === 1, 'the booking');
  assert.deepEqual(after[0].usage, { input: 90_000, output: 2_000, cacheRead: 0, usd: 0.003, tableUsd: LIST_USD });
  assert.deepEqual(after[0].ended, { end: 'answered', usd: 0.003, label: 'error', reason: 'Provider disconnected: [redacted]', tableUsd: LIST_USD });
});

test("usage whose every count is 0 (a translation's start) is no report: an error after it is refused at $0", async (t) => {
  const { p, after } = await proxy(t, { fetch: answering(stream(usageEvent({ in: 0, out: 0 }), OVERLOADED)) });
  await send(p.url);
  await until(() => after.length === 1, 'the booking');
  assert.deepEqual(after[0].ended, { end: 'nothing', label: 'refused', reason: 'Overloaded' });
});

test("an error whose data is words, not JSON (a failure a translation reports with no provider event), is booked as before: unknown", async (t) => {
  const { p, after } = await proxy(t, { fetch: answering(stream('event: error\ndata: 500 the upstream failed')) });
  await send(p.url);
  await until(() => after.length === 1, 'the booking');
  assert.deepEqual(after[0].ended, { end: 'answered', usd: null });
});

test("an error once the model's content streamed with no usage reported is not refused: an unknown cost, the hold, with its words", async (t) => {
  const contentPolicy = { ...policy, contentBytesOf: (event) => (/"content":"([^"]+)"/.exec(event)?.[1].length ?? 0) };
  const after = [];
  const p = await startModelProxy({
    policy: contentPolicy, model: 'session-model', origin: 'https://provider.invalid', credential: () => SECRET,
    hooks: { beforeRequest: async () => ({ turn: 1 }), afterRequest: async (usage, _ticket, ended) => void after.push({ usage, ended }) },
    price: () => LIST_USD, fetch: answering(stream('data: {"choices":[{"delta":{"content":"Hello"}}]}', `data: ${JSON.stringify(FAILED)}`)),
  }, KEY);
  t.after(() => p.close());
  await send(p.url);
  await until(() => after.length === 1, 'the booking');
  assert.deepEqual(after[0].ended, { end: 'answered', usd: null, label: 'error', reason: 'Provider disconnected: [redacted]' });
  assert.deepEqual(bookRequest(after[0].ended, { hold: 0.05 }), { usd: 0.05, rule: 'answered:error' });
});

// Missing content is not proof the provider refused: a stream that shows the model began its output (a Messages block it
// opened, a Responses output item, a Chat Completions delta with something in it) ran, even where none of its content
// streamed (hidden reasoning, a block a translation held). An error after that with nothing reported is unknown.
const BEGAN = {
  'a Messages block opened': stream(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0}}}`, `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`, OVERLOADED),
  'a Responses output item (hidden reasoning)': stream(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } })}`, `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'Overloaded' } } })}`),
  'a Chat Completions reasoning delta': stream(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning: 'Let me think' } }] })}`, `data: ${JSON.stringify({ error: { code: 502, message: 'Overloaded' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })}`),
};

for (const [began, body] of Object.entries(BEGAN)) {
  test(`an error with nothing reported once the model began its output (${began}) is not refused: an unknown cost, with its words`, async (t) => {
    const { p, after } = await proxy(t, { fetch: answering(body) });
    await send(p.url);
    await until(() => after.length === 1, 'the booking');
    assert.deepEqual(after[0].ended, { end: 'answered', usd: null, label: 'error', reason: 'Overloaded' });
  });
}

test("the run's books keep both: the reported figure with the table's beside it, and a refusal at $0 with its words", async (t) => {
  const store = memorySessionStore();
  const key = 'chat:provider-cost';
  const booking = await modelPortFor(await store.open(key), { key });
  let n = 0;
  const bodies = [stream(usageEvent({ in: 90_000, out: 2_000, cost: 0.003 })), RATE_LIMITS['chat completions']];
  const { p } = await proxy(t, { hooks: booking.models, fetch: async () => answering(bodies[n++])() });
  await send(p.url);
  await send(p.url);
  await until(async () => (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.turn).length === 2, 'both turns recorded');
  const turns = (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.turn).map(({ data: { turn, usd, tableUsd, bookedUsd, rule, refusal } }) => ({ turn, usd, tableUsd, bookedUsd, rule, refusal }));
  assert.deepEqual(turns, [
    { turn: 1, usd: 0.003, tableUsd: LIST_USD, bookedUsd: 0.003, rule: 'answered', refusal: undefined },
    { turn: 2, usd: 0, tableUsd: undefined, bookedUsd: 0, rule: 'nothing:refused', refusal: 'Rate limit exceeded: [redacted] free-models-per-min' },
  ]);
});
