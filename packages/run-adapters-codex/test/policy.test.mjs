// The Codex policy behind the session's model proxy (@parcha/agentrun-adapters/host), through a real proxy to a scripted
// provider, on a request and a stream the pinned CLI (0.164.0) exchanged with a Responses provider, recorded with their
// ids replaced (test/fixtures). No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-adapters/host';
import { codexPolicy, usageOf } from '../dist/host/policy.js';

const KEY = 'session-key-for-tests';
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const RECORDED_REQUEST = JSON.parse(fixture('responses-request-gpt-5.4-mini.json'));
const RECORDED_STREAM = fixture('responses-stream-gpt-5.4-mini.sse');
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const completed = (usage, extra = {}) => ({ type: 'response.completed', response: { object: 'response', status: 'completed', ...extra, usage } });

/** A proxy on the Codex policy whose provider answers each request with `answer()` (a Response). */
async function proxy({ tools = ['lookup'], answer = () => new Response(RECORDED_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }) } = {}) {
  const forwarded = [];
  const asked = [];
  const reports = [];
  const p = await startModelProxy({
    policy: codexPolicy({ model: 'session-model', tools }),
    hooks: { beforeRequest: async (r) => { asked.push(r); }, afterRequest: async (u) => { reports.push(u); } },
    model: 'session-model',
    origin: 'https://provider.invalid',
    credential: () => 'provider-secret',
    price: (_model, u) => (u.input + u.output + u.cacheRead) / 1e6,
    fetch: async (url, init) => { forwarded.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return answer(); },
  }, KEY);
  after(() => p.close());
  return { p, forwarded, asked, reports };
}

/** One HTTP request to the proxy; `headers` replaces the defaults (a key, JSON). */
function send(url, { method = 'POST', path = '/v1/responses', body, headers } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method, path, headers: headers ?? { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, accept: 'text/event-stream', 'session-id': 'sid', 'thread-id': 'tid', 'x-client-request-id': 'rid', 'x-codex-window-id': 'wid', originator: 'codex_exec' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

test("the recorded request reaches the provider as the policy shapes it: the session's model and tools, no ids, no stored response", async () => {
  const { p, forwarded, asked } = await proxy();
  const r = await send(p.url, { body: { ...RECORDED_REQUEST, tools: [...RECORDED_REQUEST.tools, { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }] } });
  assert.equal(r.status, 200);
  const [f] = forwarded;
  assert.equal(f.url, 'https://provider.invalid/v1/responses');
  assert.deepEqual(Object.keys(f.headers).sort(), ['accept', 'authorization', 'content-type'], 'only accept is forwarded of the CLI\'s headers');
  assert.equal(f.headers.authorization, 'Bearer provider-secret');
  assert.deepEqual(Object.keys(f.body).sort(), ['include', 'input', 'max_output_tokens', 'model', 'parallel_tool_calls', 'prompt_cache_key', 'reasoning', 'store', 'stream', 'tool_choice', 'tools']);
  assert.deepEqual([f.body.model, f.body.store, f.body.max_output_tokens, f.body.include], ['session-model', false, 32_000, ['reasoning.encrypted_content']]);
  // web search, the CLI's built-ins and its multi-agent namespace are not the session's: only `lookup` is offered.
  assert.deepEqual(f.body.tools.map((t) => `${t.type}:${t.name}`), ['function:lookup']);
  assert.deepEqual(asked, [{ model: 'session-model' }], "the runner is asked about the applied body's model");
  const sent = JSON.stringify(f);
  for (const id of ['<x-codex-installation-id>', '<session_id>', 'sid', 'tid', 'rid', 'wid', 'codex_exec', KEY]) assert.ok(!sent.includes(id), `${id} does not reach the provider`);
});

test("the recorded stream's usage is booked from response.completed, read as JSON", async () => {
  const { p, reports } = await proxy();
  assert.equal((await send(p.url, { body: RECORDED_REQUEST })).status, 200);
  await settled();
  assert.deepEqual(reports, [{ input: 13902, output: 5, cacheRead: 0, cacheWrite: 0, usd: 13907 / 1e6 }]);
});

test('cached and cache-write tokens are booked apart from input, which OpenAI counts them in; reasoning is in output', () => {
  const usage = { input_tokens: 13902, input_tokens_details: { cached_tokens: 9000, cache_write_tokens: 400 }, output_tokens: 120, output_tokens_details: { reasoning_tokens: 80 }, total_tokens: 14022 };
  assert.deepEqual(usageOf(sse([{ type: 'response.created', response: { usage: null } }, completed(usage)])), { input: 4502, output: 120, cacheRead: 9000, cacheWrite: 400 });
  assert.deepEqual(usageOf(sse([{ type: 'response.incomplete', response: { usage } }])), { input: 4502, output: 120, cacheRead: 9000, cacheWrite: 400 }, 'a response cut at its output limit was paid');
});

test('a completed event longer than the window the proxy keeps (its encrypted reasoning) is still booked, not unknown', async () => {
  const usage = { input_tokens: 50_000, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 }, output_tokens: 700, output_tokens_details: { reasoning_tokens: 500 }, total_tokens: 50_700 };
  const reasoning = { type: 'reasoning', encrypted_content: 'e'.repeat(200 * 1024), summary: [] };
  // tool_usage comes after usage and nests objects with their own input_tokens: they are not the response's usage.
  const tool_usage = { image_gen: { input_tokens: 999, output_tokens: 999 }, web_search: { num_requests: 0 } };
  const stream = sse([{ type: 'response.created', response: { usage: null } }, completed(usage, { output: [reasoning, { type: 'message', content: [{ type: 'output_text', text: 'a "usage":{"input_tokens":1} in quotes' }] }], tool_usage })]) + 'data: [DONE]\n\n';
  const { p, reports } = await proxy({ answer: () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal((await send(p.url, { body: RECORDED_REQUEST })).status, 200);
  await settled();
  assert.deepEqual(reports.map(({ usd, ...u }) => u), [{ input: 49_000, output: 700, cacheRead: 1000, cacheWrite: 0 }]);
  assert.notEqual(reports[0].usd, null);
});

test("past the window, the model's own text saying a zero usage is never booked: the real one, or an unknown cost", async () => {
  // JSON escapes every quote in a string, so a model that writes the key (even with its own backslashes) never forms
  // the bare `"usage":{` the window fallback reads; placed before the real usage, after it, and across the window's start.
  const fake = 'here is "usage":{"input_tokens":0,"output_tokens":0} and \\"usage\\":{"input_tokens":0,"output_tokens":0}';
  const usage = { input_tokens: 80_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 900, output_tokens_details: { reasoning_tokens: 600 }, total_tokens: 80_900 };
  const reasoning = { type: 'reasoning', encrypted_content: 'e'.repeat(200 * 1024), summary: [] };
  const message = { type: 'message', content: [{ type: 'output_text', text: fake.repeat(50) }] };
  const event = (after) => ({ type: 'response.completed', response: { object: 'response', status: 'completed', output: [reasoning, message], usage, instructions: after, tool_usage: { web_search: { num_requests: 0 } } } });
  const answer = (after) => () => new Response(sse([{ type: 'response.created', response: { usage: null } }, event(after)]) + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  // The real usage is inside the tail window, with the model's text on both sides of it.
  const near = await proxy({ answer: answer(fake.repeat(50)) });
  assert.equal((await send(near.p.url, { body: RECORDED_REQUEST })).status, 200);
  await settled();
  assert.deepEqual(near.reports.map(({ usd, ...u }) => u), [{ input: 80_000, output: 900, cacheRead: 0, cacheWrite: 0 }]);
  // A string after it longer than the window: the real usage is in neither window, and only the model's text is.
  const far = await proxy({ answer: answer(fake.repeat(1200)) });
  assert.equal((await send(far.p.url, { body: RECORDED_REQUEST })).status, 200);
  await settled();
  assert.equal(far.reports.length, 1);
  assert.equal(far.reports[0].usd, null, 'unknown, never the zero the text says');
  // A window that starts in the middle of that text reads nothing from it.
  const line = `data: ${JSON.stringify(event(fake.repeat(1200)))}`;
  for (const cut of [1, 7, 13, 64 * 1024]) assert.equal(usageOf(line.slice(-(64 * 1024) - cut).slice(0, 64 * 1024)), undefined, `cut ${cut}`);
});

test('no response.completed, or one with no usage, is an unknown cost, never a guess', () => {
  assert.equal(usageOf(sse([{ type: 'response.created', response: { usage: null } }, { type: 'response.output_text.delta', delta: '"usage":{"input_tokens":5,"output_tokens":5}' }])), undefined);
  assert.equal(usageOf(sse([completed(undefined)])), undefined);
  assert.equal(usageOf(sse([completed({ input_tokens: '7', output_tokens: 2 })])), undefined);
  assert.equal(usageOf(''), undefined);
});

test("Codex's keyless probe, GET /, is answered here: never forwarded, never booked", async () => {
  const { p, forwarded, reports } = await proxy();
  const r = await send(p.url, { method: 'GET', path: '/', headers: { 'user-agent': 'codex' } });
  assert.equal(r.status, 404);
  await settled();
  assert.deepEqual([forwarded.length, reports.length], [0, 0]);
});

test('a paid request the provider admitted but that was cut off before completing is booked once, at an unknown cost', async () => {
  const cut = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse([{ type: 'response.created', response: { usage: null } }]))); c.error(new Error('aborted')); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { p, reports } = await proxy({ answer: cut });
  await send(p.url, { body: RECORDED_REQUEST }).catch(() => {});
  await settled();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].usd, null);
});

test('without the session key every route gets the same 401, so the table cannot be mapped', async () => {
  const { p, forwarded } = await proxy();
  const answers = [];
  for (const [method, path] of [['POST', '/v1/responses'], ['POST', '/v1/chat/completions'], ['GET', '/v1/models']]) {
    answers.push(await send(p.url, { method, path, body: {}, headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' } }));
  }
  assert.deepEqual(answers.map((a) => a.status), [401, 401, 401]);
  assert.equal(new Set(answers.map((a) => a.text)).size, 1);
  assert.equal(forwarded.length, 0);
});

test('a refusal names the kind of thing refused, never a value from the request', async () => {
  const { p, forwarded } = await proxy();
  const secret = 'value-from-the-request-x9';
  const refused = [
    [{ ...RECORDED_REQUEST, tools: [{ type: secret }] }, 403],
    [{ ...RECORDED_REQUEST, tools: [{ type: 'file_search' }] }, 403],
    [{ ...RECORDED_REQUEST, [secret]: true }, 400],
    [{ ...RECORDED_REQUEST, service_tier: 'priority' }, 400],
    [{ ...RECORDED_REQUEST, include: [secret] }, 400],
    [{ ...RECORDED_REQUEST, include: ['file_search_call.results'] }, 400],
    [{ ...RECORDED_REQUEST, tool_choice: { type: 'function', name: secret } }, 400],
    [{ ...RECORDED_REQUEST, stream: secret }, 400],
    [[secret], 400],
  ];
  for (const [body, status] of refused) {
    const r = await send(p.url, { body });
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 80));
    assert.ok(!r.text.includes(secret), `the refusal does not echo the request: ${r.text}`);
  }
  assert.equal(forwarded.length, 0);
});

test('a node with an output schema: the recorded request carries `text` with a JSON schema, and it is shaped and sent', async () => {
  const recorded = JSON.parse(fixture('responses-request-schema-gpt-5.4-mini.json'));
  const { p, forwarded } = await proxy();
  const r = await send(p.url, { body: recorded });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(forwarded[0].body.text, recorded.text);
  assert.equal(forwarded[0].body.text.format.type, 'json_schema');
  for (const text of [{ format: { type: 'text' } }, { verbosity: 'low' }, { format: { type: 'json_schema', name: 'out', schema: { type: 'object' } }, verbosity: 'high' }]) {
    assert.equal((await send(p.url, { body: { ...recorded, text } })).status, 200, JSON.stringify(text));
  }
  assert.equal(forwarded.length, 4);
});

test('`text` carries only a format (plain text, or a JSON schema) and a verbosity; anything else is refused, echoing nothing', async () => {
  const recorded = JSON.parse(fixture('responses-request-schema-gpt-5.4-mini.json'));
  const { p, forwarded } = await proxy();
  const secret = 'value-from-the-request-t4';
  for (const text of [
    secret,
    { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true, [secret]: 1 } },
    { format: { type: 'json_object' } },
    { format: { type: secret } },
    { format: { type: 'text', name: secret } },
    { format: { type: 'json_schema', name: 'out' } },
    { format: { type: 'json_schema', name: 7, schema: {} } },
    { format: { type: 'json_schema', name: 'out', schema: {}, strict: secret } },
    { verbosity: secret },
    { format: { type: 'text' }, [secret]: true },
  ]) {
    const r = await send(p.url, { body: { ...recorded, text } });
    assert.equal(r.status, 400, JSON.stringify(text));
    assert.ok(!r.text.includes(secret), `the refusal does not echo the request: ${r.text}`);
  }
  assert.equal(forwarded.length, 0);
});

test('a request asking to store its response reaches the provider as store: false', async () => {
  const { p, forwarded } = await proxy();
  assert.equal((await send(p.url, { body: { ...RECORDED_REQUEST, store: true } })).status, 200);
  assert.equal(forwarded[0].body.store, false);
});

test('a request asking for more output than the session allows is clamped to it; a smaller ask is kept', async () => {
  const { p, forwarded } = await proxy();
  for (const asked of [10_000_000, 32_001, 100]) assert.equal((await send(p.url, { body: { ...RECORDED_REQUEST, max_output_tokens: asked } })).status, 200);
  assert.deepEqual(forwarded.map((f) => f.body.max_output_tokens), [32_000, 32_000, 100]);
});

test('a paid answer cut at its output limit (response.incomplete) is booked at its usage and priced, not unknown', async () => {
  const usage = { input_tokens: 3000, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 }, output_tokens: 32_000, output_tokens_details: { reasoning_tokens: 9000 }, total_tokens: 35_000 };
  // Valid JSON with spaces after its colons, as a provider may send it: only the event's own parse can read it.
  const spaced = (event) => JSON.stringify(event).replace(/":/g, '": ');
  const stream = `data: ${spaced({ type: 'response.created', response: { usage: null } })}\n\ndata: ${spaced({ type: 'response.incomplete', response: { object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage } })}\n\n`;
  const { p, reports } = await proxy({ answer: () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal((await send(p.url, { body: RECORDED_REQUEST })).status, 200);
  await settled();
  assert.deepEqual(reports, [{ input: 2000, output: 32_000, cacheRead: 1000, cacheWrite: 0, usd: (2000 + 32_000 + 1000) / 1e6 }]);
});
