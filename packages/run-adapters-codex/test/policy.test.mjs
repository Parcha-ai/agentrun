// The Codex policy behind the session's model proxy (@parcha/agentrun-kernel/host), through a real proxy to a scripted
// provider, on a request and a stream the pinned CLI (0.164.0) exchanged with a Responses provider, recorded with their
// ids replaced (test/fixtures). No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, test } from 'node:test';
import { modelPortFor } from '@parcha/agentrun-kernel';
import * as host from '@parcha/agentrun-kernel/host';
import { codexPolicy, usageOf, webSearchUsd, withWebSearches } from '../dist/host/policy.js';

const { startModelProxy } = host;

const KEY = 'session-key-for-tests';
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const RECORDED_REQUEST = JSON.parse(fixture('responses-request-gpt-5.4-mini.json'));
const RECORDED_STREAM = fixture('responses-stream-gpt-5.4-mini.sse');
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const completed = (usage, extra = {}) => ({ type: 'response.completed', response: { object: 'response', status: 'completed', ...extra, usage } });

/** A proxy on the Codex policy whose provider answers each request with `answer()` (a Response). With `webSearch`, the
 *  price adds each search, as the session's machine wires it. */
async function proxy({ tools = ['lookup'], announce, webSearch, model = 'session-model', hooks, answer = () => new Response(RECORDED_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }) } = {}) {
  const forwarded = [];
  const asked = [];
  const reports = [];
  const tokens = (_model, u) => (u.input + u.output + u.cacheRead) / 1e6;
  const p = await startModelProxy({
    policy: codexPolicy({ model, tools, ...(announce ? { announce } : {}), ...(webSearch ? { webSearch } : {}) }),
    hooks: hooks ?? { beforeRequest: async (r) => { asked.push(r); }, afterRequest: async (u) => { reports.push(u); } },
    model,
    origin: 'https://provider.invalid',
    credential: () => 'provider-secret',
    price: webSearch ? withWebSearches(tokens) : tokens,
    fetch: async (url, init) => { forwarded.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body }); return answer(); },
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
  // With the output the body asks for (the policy's clamp, 32,000) and the least it may be limited to and still answer.
  assert.deepEqual(asked, [{ model: 'session-model', inputTokensMax: Buffer.byteLength(f.raw, 'utf8'), outputTokensAsked: 32_000, outputTokensLeast: 1_024 }], "the runner is asked about the applied body's model, with its input bound (the sent body's bytes), its output and its least");
  const sent = JSON.stringify(f);
  for (const id of ['<x-codex-installation-id>', '<session_id>', 'sid', 'tid', 'rid', 'wid', 'codex_exec', KEY]) assert.ok(!sent.includes(id), `${id} does not reach the provider`);
});

test("the Responses API adds no billed input the body does not carry: the input bound is the sent body's bytes, tools or not", async () => {
  const policy = codexPolicy({ model: 'session-model', tools: ['lookup'] });
  for (const body of [{}, { tools: [{ type: 'function', name: 'lookup' }], tool_choice: 'required' }, RECORDED_REQUEST]) assert.equal(policy.serverInputOverhead(body), 0);
  const { p, forwarded, asked } = await proxy();
  await send(p.url, { body: { ...RECORDED_REQUEST, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }] } });
  assert.deepEqual(asked.map((r) => r.inputTokensMax), [Buffer.byteLength(forwarded[0].raw, 'utf8')]);
});

// A tool's output may hold an image; the Responses API bills it by its area, not its bytes.
const imageItem = { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' };
const withImages = (n) => ({ ...RECORDED_REQUEST, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }], input: [...RECORDED_REQUEST.input, { type: 'function_call_output', call_id: 'c1', output: Array.from({ length: n }, () => imageItem) }] });

test("each image adds the most one image is billed as on the Responses API, 73,800 tokens (30,000 patches x 2.46), through the shared figures", () => {
  const policy = codexPolicy({ model: 'session-model', tools: ['lookup'] });
  assert.equal(host.OPENAI_IMAGE_TOKENS_MAX, 73_800);
  assert.deepEqual([withImages(1), withImages(3)].map((body) => policy.serverInputOverhead(body)), [73_800, 3 * 73_800]);
  assert.equal(policy.serverInputOverhead(withImages(1)), host.providerInputOverhead?.('openai-responses', { tools: true, images: 1 }), 'the policy and the shared function agree');
});

test("a body with a file input (billed by its pages, with no stated bound) leaves the input bound unmeasured, so a cap treats it as unknown", async () => {
  const policy = codexPolicy({ model: 'session-model', tools: ['lookup'] });
  const withFile = { ...RECORDED_REQUEST, input: [...RECORDED_REQUEST.input, { type: 'message', role: 'user', content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=' }] }] };
  assert.throws(() => policy.serverInputOverhead(withFile), /no stated bound/);
  const { p, asked } = await proxy();
  await send(p.url, { body: withFile });
  assert.equal(asked.length, 1);
  assert.ok('inputTokensMax' in asked[0] && asked[0].inputTokensMax === undefined, JSON.stringify(asked[0]));
});

test("a request whose body fits what is left, but not with its image's allowance, is refused before it is sent", async () => {
  const body = withImages(1);
  const sentBy = async (room) => {
    const sent = [];
    const p = await startModelProxy({
      policy: codexPolicy({ model: 'session-model', tools: ['lookup'] }), model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
      hooks: { beforeRequest: async (r) => { if (r.inputTokensMax === undefined || r.inputTokensMax > room(r)) throw new Error('over what is left'); }, afterRequest: async () => {} },
      fetch: async (_url, init) => { sent.push(init.body); return new Response(RECORDED_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
    }, KEY);
    after(() => p.close());
    await send(p.url, { body });
    return sent;
  };
  // Room for the body's bytes and all of the image's allowance but one token: refused, the provider sees nothing.
  let bytes;
  const refused = await sentBy((r) => { bytes = r.inputTokensMax - 73_800; return bytes + 73_800 - 1; });
  assert.equal(refused.length, 0);
  const passed = await sentBy(() => bytes + 73_800);
  assert.equal(passed.length, 1);
  assert.equal(Buffer.byteLength(passed[0], 'utf8'), bytes, 'the bound is the sent body\'s bytes plus the image allowance');
});

test("the recorded stream's usage is booked from response.completed, read as JSON", async () => {
  const { p, reports } = await proxy();
  assert.equal((await send(p.url, { body: RECORDED_REQUEST })).status, 200);
  await settled();
  assert.deepEqual(reports, [{ input: 13902, output: 5, cacheRead: 0, cacheWrite: 0, usd: 13907 / 1e6, estimated: true }]);
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
  assert.deepEqual(reports.map(({ usd, ...u }) => u), [{ input: 49_000, output: 700, cacheRead: 1000, cacheWrite: 0, estimated: true }]);
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
  assert.deepEqual(near.reports.map(({ usd, ...u }) => u), [{ input: 80_000, output: 900, cacheRead: 0, cacheWrite: 0, estimated: true }]);
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
  assert.deepEqual(reports, [{ input: 2000, output: 32_000, cacheRead: 1000, cacheWrite: 0, usd: (2000 + 32_000 + 1000) / 1e6, estimated: true }]);
});

const CODE_MODE_CARRIER = {
  type: 'additional_tools', id: 'at_1', role: 'developer',
  tools: [
    { type: 'namespace', name: 'functions', description: '', tools: [
      { type: 'custom', name: 'exec', description: 'Run JavaScript.', format: { type: 'text' } },
      { type: 'function', name: 'wait', description: 'Wait.', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'request_user_input', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'exec', parameters: { type: 'object', properties: {} } },
    ] },
    { type: 'namespace', name: 'collaboration', description: '', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: {} } }] },
  ],
};

test("a code-mode request passes with Codex's exec and wait and nothing else of its additional_tools: sub-agent and user-input tools are dropped", async () => {
  const { p, forwarded } = await proxy();
  const r = await send(p.url, { body: { ...RECORDED_REQUEST, parallel_tool_calls: false, input: [...RECORDED_REQUEST.input, CODE_MODE_CARRIER] } });
  assert.equal(r.status, 200, r.text);
  const carrier = forwarded[0].body.input.find((item) => item.type === 'additional_tools');
  assert.deepEqual(carrier.tools.map((t) => [t.name, t.tools.map((x) => `${x.type}:${x.name}`)]), [['functions', ['custom:exec', 'function:wait']]]);
  assert.equal(carrier.id, 'at_1', 'the rest of the item is as sent');
  assert.deepEqual(forwarded[0].body.input.filter((item) => item.type !== 'additional_tools'), RECORDED_REQUEST.input, 'other input items are as sent');
  // A carrier of another shape is refused, never passed on as it is.
  for (const bad of [{ type: 'additional_tools' }, { type: 'additional_tools', tools: [{ type: 'function', name: 'exec' }] }, { type: 'additional_tools', tools: 'exec' }]) {
    const refused = await send(p.url, { body: { ...RECORDED_REQUEST, parallel_tool_calls: false, input: [...RECORDED_REQUEST.input, bad] } });
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  // A top-level carrier is not the session's tool either: it is dropped, so no code-mode runtime is offered.
  assert.equal((await send(p.url, { body: { ...RECORDED_REQUEST, tools: [{ type: 'custom', name: 'exec' }, { type: 'function', name: 'wait' }, { type: 'function', name: 'lookup' }] } })).status, 200);
  assert.deepEqual(forwarded.at(-1).body.tools.map((t) => t.name), ['lookup']);
});

test("a code-mode request has parallel tool calls off: written false when the CLI says nothing, false kept, true refused; a classic request is as sent", async () => {
  const { p, forwarded } = await proxy();
  const codeMode = { ...RECORDED_REQUEST, input: [...RECORDED_REQUEST.input, CODE_MODE_CARRIER] };
  const { parallel_tool_calls: _, ...without } = codeMode;
  assert.equal((await send(p.url, { body: without })).status, 200);
  assert.equal(forwarded.at(-1).body.parallel_tool_calls, false, 'written when absent');
  assert.equal((await send(p.url, { body: { ...codeMode, parallel_tool_calls: false } })).status, 200);
  assert.equal(forwarded.at(-1).body.parallel_tool_calls, false);
  const before = forwarded.length;
  for (const value of [true, 'yes', 1, null]) assert.equal((await send(p.url, { body: { ...codeMode, parallel_tool_calls: value } })).status, 400, String(value));
  assert.equal(forwarded.length, before, 'nothing was forwarded');
  assert.equal(RECORDED_REQUEST.parallel_tool_calls, true, 'the recorded classic request allows them');
  assert.equal((await send(p.url, { body: RECORDED_REQUEST })).status, 200);
  assert.equal(forwarded.at(-1).body.parallel_tool_calls, true, 'a classic request is as the CLI sent it');
});

/** A request's input with a code-mode `exec` that yielded (and then, if `after` is given, the `wait` items after it). */
const yielded = (...after) => [
  ...RECORDED_REQUEST.input,
  { type: 'custom_tool_call', name: 'exec', call_id: 'call_a', input: 'await tools.slow({})' },
  { type: 'custom_tool_call_output', call_id: 'call_a', output: 'Script running with cell ID 1\nWall time 0.1 seconds\nOutput:\n' },
  ...after,
];
const waitOn = (callId, cell) => ({ type: 'function_call', name: 'wait', call_id: callId, arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 5000 }) });
const waited = (callId, text) => ({ type: 'function_call_output', call_id: callId, output: [{ type: 'input_text', text }] });
const offered = (forwarded) => forwarded.at(-1).body.input.find((item) => item.type === 'additional_tools').tools.find((t) => t.name === 'functions').tools.map((t) => t.name);

test("exec is not offered while a script that yielded still runs, only wait; it is offered again once the script ended", async () => {
  const { p, forwarded } = await proxy();
  const ask = async (input) => {
    const r = await send(p.url, { body: { ...RECORDED_REQUEST, parallel_tool_calls: false, input: [...input, CODE_MODE_CARRIER] } });
    assert.equal(r.status, 200, r.text);
    return offered(forwarded);
  };
  assert.deepEqual(await ask(RECORDED_REQUEST.input), ['exec', 'wait'], 'no script yet');
  assert.deepEqual(await ask(yielded()), ['wait'], 'the script yielded and runs');
  assert.deepEqual(await ask(yielded(waitOn('call_w', '1'), waited('call_w', 'Script running with cell ID 1\nWall time 5 seconds'))), ['wait'], 'still running after a wait');
  assert.deepEqual(await ask(yielded(waitOn('call_w', '1'), waited('call_w', 'Script completed\nWall time 1.8 seconds\nOutput:\n'))), ['exec', 'wait'], 'ended');
  assert.deepEqual(await ask(yielded(waitOn('call_w', '1'), waited('call_w', 'Script failed\nScript error:\nexec cell 1 not found'))), ['exec', 'wait'], 'gone');
  assert.deepEqual(await ask([...RECORDED_REQUEST.input, { type: 'custom_tool_call', name: 'exec', call_id: 'call_b', input: 'text(1)' }, { type: 'custom_tool_call_output', call_id: 'call_b', output: 'Script completed\nWall time 0.0 seconds' }]), ['exec', 'wait'], 'an exec that finished at once');
});

/** Sends `pieces` as one answer through a proxy whose session is told by `told`; resolves with what the client had, and what the session was told, when the client first held an event ending after `marker` (its dispatch: the blank line). */
async function dispatchedBefore(pieces, marker, announce) {
  const told = [];
  const encoder = new TextEncoder();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stream = new ReadableStream({
    async start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      await gate;
      controller.close();
    },
  });
  const { p } = await proxy({
    announce: { response: () => told.push('response'), exec: (id) => told.push(`exec ${id}`), failed: () => told.push('failed'), end: () => told.push('end'), ...announce },
    answer: () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const { hostname, port } = new URL(p.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      let at;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        // The client holds the exec event whole (its blank line is in): the session must already have been told.
        if (at === undefined && new RegExp(`${marker}[\\s\\S]*?(\\r\\n\\r\\n|\\n\\n|\\r\\r)`).test(text)) { at = [...told]; setTimeout(() => { release(); }, 20); }
      });
      res.on('end', () => resolve({ atDispatch: at, told, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ ...RECORDED_REQUEST, parallel_tool_calls: false }));
  });
}
const execEvent = (id) => ({ type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'exec', call_id: id, input: 'text(1)' } });

test("the proxy tells the session which exec an answer carries before the client holds the event, however the event is split", async () => {
  const whole = sse([{ type: 'response.output_item.done', item: { type: 'function_call', name: 'wait', call_id: 'call_w', arguments: '{}' } }, execEvent('call_x')]);
  const at = whole.indexOf('call_x');
  for (const cut of [at + 3, whole.length - 1, whole.length - 2, at]) {
    const r = await dispatchedBefore([whole.slice(0, cut), whole.slice(cut)], 'call_x');
    assert.deepEqual(r.atDispatch, ['response', 'exec call_x'], `split at ${cut}: told before the client held the event`);
    assert.equal(r.told.filter((x) => x === 'exec call_x').length, 1, 'once');
    assert.equal(r.told.at(-1), 'end', 'the answer is closed');
  }
});

test("the reader takes an event as the format has it: data over several lines joined with LF, CRLF and bare-CR line ends", async () => {
  const json = JSON.stringify(execEvent('call_x'));
  const half = Math.floor(json.length / 2);
  const multi = `data: ${json.slice(0, half)}\ndata: ${json.slice(half)}\n\n`;
  const lineBreak = json.indexOf('"call_id"');
  const joined = `data: ${json.slice(0, lineBreak)}\ndata:${json.slice(lineBreak)}\n\n`;
  for (const [what, text] of [['an event over a CRLF', sse([execEvent('call_x')]).replace(/\n/g, '\r\n')], ['bare CRs', sse([execEvent('call_x')]).replace(/\n/g, '\r')], ['data on two lines (split inside the JSON at a space-free place)', joined], ['no space after data:', `data:${json}\n\n`]]) {
    const r = await dispatchedBefore([text.slice(0, 20), text.slice(20)], 'call_x');
    assert.deepEqual(r.told.filter((x) => x.startsWith('exec')), ['exec call_x'], what);
  }
  // A JSON string cannot hold a raw LF, so two data lines joined with LF must still parse where the LF fell between tokens.
  const tokens = `data: {"type":"response.output_item.done",\ndata: "item":{"type":"custom_tool_call","name":"exec","call_id":"call_m","input":"x"}}\n\n`;
  const r = await dispatchedBefore([tokens], 'call_m');
  assert.deepEqual(r.told.filter((x) => x.startsWith('exec')), ['exec call_m'], multi.length ? 'data spread over several data: lines' : '');
});

test("an event over the cap is not read: the answer is reported as not watched, and the client still has it whole", async () => {
  const huge = `data: {"type":"x","pad":"${'a'.repeat(4 * 1024 * 1024 + 10)}"}\n\n`;
  const r = await dispatchedBefore([huge.slice(0, 1000), huge.slice(1000), sse([execEvent('call_after')])], 'call_after');
  assert.ok(r.told.includes('failed'), 'reported as failed');
  assert.ok(!r.told.some((x) => x.startsWith('exec')), 'nothing after the unread event is announced either');
  assert.ok(r.text.includes('call_after'), 'the client has the whole answer');
});
test("a watcher that fails mid-answer is told to the session (failed), the answer still reaches the client whole, and a policy with no watcher answers the same bytes", async () => {
  const exec = { type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'exec', call_id: 'call_x', input: 'text(1)' } };
  const body = sse([exec, completed({ input_tokens: 5, output_tokens: 2 })]);
  const told = [];
  const answer = () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const watched = await proxy({ announce: { response: () => told.push('response'), exec: () => { throw new Error('the session could not take it'); }, failed: () => told.push('failed'), end: () => told.push('end') }, answer });
  const plain = await proxy({ answer });
  const a = await send(watched.p.url, { body: { ...RECORDED_REQUEST, parallel_tool_calls: false } });
  const b = await send(plain.p.url, { body: { ...RECORDED_REQUEST, parallel_tool_calls: false } });
  assert.equal(a.status, 200);
  assert.deepEqual(told, ['response', 'failed', 'end'], 'the failure was told, once, and the answer closed');
  assert.equal(a.text, body, 'the client has the whole answer');
  assert.equal(b.text, a.text, 'a policy with no watcher answers the same bytes');
});

test("a watcher that cannot start is told to the session as an answer not watched, and the answer still reaches the client", async () => {
  const told = [];
  const body = sse([completed({ input_tokens: 5, output_tokens: 2 })]);
  const { p } = await proxy({
    announce: { response: () => { throw new Error('cannot start'); }, exec: () => told.push('exec'), failed: () => told.push('failed'), end: () => told.push('end') },
    answer: () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const r = await send(p.url, { body: { ...RECORDED_REQUEST, parallel_tool_calls: false } });
  assert.equal(r.status, 200);
  assert.equal(r.text, body);
  assert.deepEqual(told, ['failed'], 'the session was told this answer is not watched');
});

test("exec is offered after a script that finished and printed the running phrase: only Codex's status header says a cell runs", async () => {
  const { p, forwarded } = await proxy();
  const printed = 'Script running with cell ID 1';
  const input = [...RECORDED_REQUEST.input,
    { type: 'custom_tool_call', name: 'exec', call_id: 'call_p', input: 'text("Script running with cell ID 1")' },
    { type: 'custom_tool_call_output', call_id: 'call_p', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: printed }] },
    CODE_MODE_CARRIER];
  const r = await send(p.url, { body: { ...RECORDED_REQUEST, parallel_tool_calls: false, input } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(offered(forwarded), ['exec', 'wait']);
});

test("exec is offered after a script that finished when Codex's header and the printed phrase share one text part: the header is read at the start only", async () => {
  const { p, forwarded } = await proxy();
  const input = [...RECORDED_REQUEST.input,
    { type: 'custom_tool_call', name: 'exec', call_id: 'call_q', input: 'text("Script running with cell ID 1")' },
    { type: 'custom_tool_call_output', call_id: 'call_q', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\nScript running with cell ID 1' }] },
    CODE_MODE_CARRIER];
  const r = await send(p.url, { body: { ...RECORDED_REQUEST, parallel_tool_calls: false, input } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(offered(forwarded), ['exec', 'wait']);
});

// Codex's own web search, live: the request the pinned CLI sent with `web_search = "live"` on the session's generated
// config, recorded behind a loopback server with its ids replaced (test/fixtures/responses-request-web-search-live.json).
const LIVE_REQUEST = JSON.parse(fixture('responses-request-web-search-live.json'));
const LIVE_TOOL = LIVE_REQUEST.tools.find((t) => t.type === 'web_search');
const LOOKUP = { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } };
const streamed = (text) => () => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
/** The recorded stream, its completed event saying the response ran `n` web searches (`tool_usage.web_search.num_requests`). */
const searched = (n) => RECORDED_STREAM.split('\n').map((line) => {
  if (!line.startsWith('data: {"type":"response.completed"')) return line;
  const event = JSON.parse(line.slice(6));
  event.response.tool_usage.web_search.num_requests = n;
  return `data: ${JSON.stringify(event)}`;
}).join('\n');
/** The recorded stream's tokens at the helper's price. */
const TOKENS_USD = 13907 / 1e6;

test('web search off: the live web search tool the CLI sends is dropped, a tool_choice naming it refused, and the usage booked as before', async () => {
  const { p, forwarded, reports } = await proxy({ model: 'gpt-5.4-mini', answer: streamed(searched(2)) });
  assert.equal((await send(p.url, { body: { ...LIVE_REQUEST, tools: [...LIVE_REQUEST.tools, LOOKUP] } })).status, 200);
  assert.deepEqual(forwarded[0].body.tools, [LOOKUP]);
  assert.equal((await send(p.url, { body: { ...LIVE_REQUEST, tool_choice: { type: 'web_search' } } })).status, 400);
  await settled();
  assert.deepEqual(reports, [{ input: 13902, output: 5, cacheRead: 0, cacheWrite: 0, usd: TOKENS_USD, estimated: true }], 'no search is read or priced');
});

test('web search live: the recorded request reaches the provider with exactly its live web search tool, and a tool_choice naming it passes', async () => {
  const policy = codexPolicy({ model: 'gpt-5.4-mini', tools: ['lookup'], webSearch: 'live' });
  assert.deepEqual([policy.serverInputOverhead({ tools: [LIVE_TOOL] }), policy.serverInputOverhead({ tools: [LOOKUP] })], [undefined, 0], 'no bound with web search, as the policy says it: no failure');
  const { p, forwarded, asked } = await proxy({ webSearch: 'live', model: 'gpt-5.4-mini' });
  assert.deepEqual(LIVE_TOOL, { type: 'web_search', external_web_access: true });
  const r = await send(p.url, { body: { ...LIVE_REQUEST, tools: [...LIVE_REQUEST.tools, LOOKUP] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(forwarded[0].body.tools, [LIVE_TOOL, LOOKUP], "the CLI's request_user_input is dropped; its live web search passes as sent");
  assert.equal((await send(p.url, { body: { ...LIVE_REQUEST, tool_choice: { type: 'web_search' } } })).status, 200);
  assert.deepEqual(forwarded[1].body.tool_choice, { type: 'web_search' });
  // A search's content is input the body does not carry, with no stated bound: unmeasured, so a cap treats it as unknown.
  assert.deepEqual(asked.map((a) => 'inputTokensMax' in a && a.inputTokensMax), [undefined, undefined]);
});

test('web search live: any other web search tool is refused, web_search_preview still dropped, every other hosted tool refused, echoing nothing', async () => {
  const { p, forwarded } = await proxy({ webSearch: 'live', model: 'gpt-5.4-mini' });
  const secret = 'value-from-the-request-x9';
  const refused = [{ ...LIVE_TOOL, search_context_size: 'high' }, { ...LIVE_TOOL, filters: { allowed_domains: [secret] } }, { ...LIVE_TOOL, external_web_access: false }, { ...LIVE_TOOL, indexed_web_access: true }, { type: 'web_search' }, { type: 'file_search' }, { type: secret }];
  for (const tool of refused) {
    const r = await send(p.url, { body: { ...LIVE_REQUEST, tools: [LIVE_TOOL, tool] } });
    assert.equal(r.status, 403, JSON.stringify(tool));
    assert.ok(!r.text.includes(secret), r.text);
  }
  for (const tool_choice of [{ type: 'web_search', external_web_access: true }, { type: 'web_search_preview' }, { type: 'file_search' }]) {
    assert.equal((await send(p.url, { body: { ...LIVE_REQUEST, tool_choice } })).status, 400, JSON.stringify(tool_choice));
  }
  assert.equal(forwarded.length, 0);
  assert.equal((await send(p.url, { body: { ...LIVE_REQUEST, tools: [LIVE_TOOL, { type: 'web_search_preview' }] } })).status, 200);
  assert.deepEqual(forwarded[0].body.tools, [LIVE_TOOL]);
});

test("web search live: each search response.completed reports is booked at OpenAI's $0.01 a call, streamed, whole, or past the window", async () => {
  const { p, reports } = await proxy({ webSearch: 'live', model: 'gpt-5.4-mini', answer: streamed(searched(3)) });
  assert.equal((await send(p.url, { body: LIVE_REQUEST })).status, 200);
  await settled();
  assert.deepEqual(reports.map(({ usd, ...u }) => u), [{ input: 13902, output: 5, cacheRead: 0, cacheWrite: 0, webSearches: 3, estimated: true }]);
  assert.ok(Math.abs(reports[0].usd - (TOKENS_USD + 3 * 0.01)) < 1e-12, String(reports[0].usd));
  const usage = { input_tokens: 10, output_tokens: 2 };
  const live = codexPolicy({ model: 'gpt-5.4-mini', tools: [], webSearch: 'live' });
  assert.equal(live.usageOf(JSON.stringify({ object: 'response', usage, tool_usage: { web_search: { num_requests: 2 } } })).webSearches, 2, 'a whole JSON body');
  assert.ok(!('webSearches' in codexPolicy({ model: 'gpt-5.4-mini', tools: [] }).usageOf(searched(2))), 'off, no search is read');
  // A completed event longer than the window the proxy keeps (its encrypted reasoning): the count is read from the tail.
  const reasoning = { type: 'reasoning', encrypted_content: 'e'.repeat(200 * 1024), summary: [] };
  const long = await proxy({ webSearch: 'live', model: 'gpt-5.4-mini', answer: streamed(sse([{ type: 'response.created', response: { usage: null } }, completed(usage, { output: [reasoning], tool_usage: { web_search: { num_requests: 4 } } })])) });
  assert.equal((await send(long.p.url, { body: LIVE_REQUEST })).status, 200);
  await settled();
  assert.equal(long.reports[0].webSearches, 4);
  assert.ok(Math.abs(long.reports[0].usd - (12 / 1e6 + 0.04)) < 1e-12, String(long.reports[0].usd));
});

test('web search live: a model with no known search price, or an answer that does not say how many searches it ran, is an unknown cost, never $0', async () => {
  assert.deepEqual(['gpt-5.4-mini', 'gpt-5.5', 'gpt-5', 'o3', 'o4-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4.1-mini', 'openai/gpt-5.4-mini', 'claude-sonnet-4-5'].map(webSearchUsd), [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, undefined, undefined, undefined, undefined]);
  const u = { input: 1, output: 1, cacheRead: 0 };
  const price = withWebSearches(() => 0.5);
  assert.deepEqual([price('gpt-5.4-mini', { ...u, webSearches: 2 }), price('gpt-4o-mini', { ...u, webSearches: 1 }), price('gpt-4o-mini', { ...u, webSearches: 0 }), price('gpt-5.4-mini', { ...u, webSearches: null }), withWebSearches(() => null)('gpt-5.4-mini', { ...u, webSearches: 0 })], [0.52, null, 0.5, null, null]);
  const unknown = await proxy({ webSearch: 'live', model: 'gateway/some-model', answer: streamed(searched(1)) });
  const silent = await proxy({ webSearch: 'live', model: 'gpt-5.4-mini', answer: streamed(sse([completed({ input_tokens: 10, output_tokens: 2 })])) });
  for (const q of [unknown, silent]) assert.equal((await send(q.p.url, { body: LIVE_REQUEST })).status, 200);
  await settled();
  assert.deepEqual([unknown.reports[0].webSearches, unknown.reports[0].usd, silent.reports[0].webSearches, silent.reports[0].usd], [1, null, null, null]);
});

test("web search live: the runner books each search into the session's spend, and the host's cap refuses the next request once it is crossed", async () => {
  // A cap of $0.03: the recorded answer's tokens ($0.0139) are under it, and with two searches ($0.02) over it.
  const session = async (searches) => {
    const booking = await modelPortFor({}, { key: 'k', budgetUsd: 0.03, records: [], append: async () => {}, beforeRequest: ({ spentUsd, budgetUsd }) => (spentUsd === null || spentUsd >= budgetUsd ? { refuse: 'over the cap' } : undefined) });
    const { p, forwarded } = await proxy({ webSearch: 'live', model: 'gpt-5.4-mini', hooks: booking.models, answer: streamed(searched(searches)) });
    const statuses = [];
    for (let i = 0; i < 2; i++) statuses.push((await send(p.url, { body: LIVE_REQUEST })).status);
    await settled();
    return { statuses, forwarded: forwarded.length, spent: booking.spentUsd() };
  };
  const none = await session(0);
  assert.deepEqual([none.statuses, none.forwarded], [[200, 200], 2]);
  const two = await session(2);
  assert.deepEqual([two.statuses, two.forwarded], [[200, 400], 1]);
  assert.ok(Math.abs(two.spent - (TOKENS_USD + 0.02)) < 1e-12, String(two.spent));
});

test("web search live: the count is the terminal event's own; an earlier event's 0 never stands in for one the window cut or the event left out", async () => {
  const usage = { input_tokens: 10, output_tokens: 2 };
  const pad = 'e'.repeat(100 * 1024);
  const reasoning = { type: 'reasoning', encrypted_content: pad, summary: [] };
  // The response's first events carry a tool_usage of their own, with no search yet.
  const started = { object: 'response', status: 'in_progress', usage: null, tool_usage: { web_search: { num_requests: 0 } } };
  const book = async (response) => {
    const events = [{ type: 'response.created', response: started }, { type: 'response.in_progress', response: started }, { type: 'response.completed', response: { object: 'response', status: 'completed', ...response, usage } }];
    const q = await proxy({ webSearch: 'live', model: 'gpt-5.4-mini', answer: streamed(`${sse(events)}data: [DONE]\n\n`) });
    assert.equal((await send(q.p.url, { body: LIVE_REQUEST })).status, 200);
    await settled();
    const [{ input, output, webSearches, usd }] = q.reports;
    return { input, output, webSearches, usd: usd === null ? null : Math.round(usd * 1e9) / 1e9 };
  };
  const unknown = { input: 10, output: 2, webSearches: null, usd: null };
  const two = { input: 10, output: 2, webSearches: 2, usd: 0.020012 };
  // A completed event longer than the window, its count between the two windows the proxy keeps: unknown.
  assert.deepEqual(await book({ output: [reasoning], tool_usage: { web_search: { num_requests: 3 } }, instructions: pad }), unknown);
  // Its count readable, whole or at the end of a line longer than the window: N searches at $0.01.
  assert.deepEqual(await book({ tool_usage: { web_search: { num_requests: 2 } } }), two);
  assert.deepEqual(await book({ output: [reasoning], tool_usage: { web_search: { num_requests: 2 } } }), two);
  // A completed event with no tool_usage, whole or longer than the window: unknown.
  assert.deepEqual(await book({}), unknown);
  assert.deepEqual(await book({ output: [reasoning] }), unknown);
});

test("a stopped Responses request's hidden reasoning, as the policy reads it from the body: its effort's budget; with no effort (or no reasoning object), its max_output_tokens, the conservative side; with effort none, none", () => {
  const policy = codexPolicy({ model: 'session-model', tools: [] });
  const hidden = (body) => policy.reasoningHidden?.(body);
  assert.deepEqual(
    [hidden({ reasoning: { effort: 'minimal' } }), hidden({ reasoning: { effort: 'low' } }), hidden({ reasoning: { effort: 'medium', summary: 'auto' } }), hidden({ reasoning: { effort: 'high' } }), hidden({ reasoning: { effort: 'xhigh' } })],
    [1_024, 2_048, 8_192, 16_384, 16_384],
    'each effort, its budget',
  );
  assert.equal(hidden({ reasoning: { effort: 'none' } }), 0, 'effort none: no reasoning');
  assert.equal(hidden({ reasoning: { summary: 'auto' }, max_output_tokens: 32_000 }), 32_000, 'no effort: its output limit');
  assert.equal(hidden({ max_output_tokens: 20_000 }), 20_000, 'no reasoning object: its output limit, as the model may reason at its default');
});

test("the reasoning a Responses stream shows, as the policy reads each event: a reasoning summary's or reasoning text's delta counts its bytes; answer text, a function call's arguments and every other event count none", () => {
  const policy = codexPolicy({ model: 'session-model', tools: [] });
  const event = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}`;
  const bytes = (e) => policy.reasoningBytesOf?.(e);
  assert.deepEqual(
    [
      bytes(event('response.reasoning_summary_text.delta', { item_id: 'rs_1', delta: 'Weighing é ✓' })),
      bytes(event('response.reasoning_text.delta', { item_id: 'rs_1', delta: 'step two' })),
      bytes(event('response.output_text.delta', { item_id: 'msg_1', delta: 'The answer' })),
      bytes(event('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"q":"x"}' })),
      bytes(event('response.completed', { response: {} })),
    ],
    [Buffer.byteLength('Weighing é ✓'), Buffer.byteLength('step two'), 0, 0, 0],
  );
});

test("a Codex request whose hidden reasoning (a short summary) came before 8,000 bytes of answer text, then stopped, counts all it was sent and the reasoning budget its summary left unseen: the text does not stand in for the reasoning", async () => {
  const summary = 'Weighing the layouts and the totals. '.repeat(8);
  const text = 'The ledger balances once the March entries move to April. '.repeat(140).slice(0, 8_000);
  const sse = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
  const stream = sse('response.created', { response: { id: 'resp_1' } }) + sse('response.reasoning_summary_text.delta', { item_id: 'rs_1', delta: summary })
    + Array.from({ length: 8 }, (_, i) => sse('response.output_text.delta', { item_id: 'msg_1', delta: text.slice(i * 1_000, (i + 1) * 1_000) })).join('');
  const reports = [];
  let reported;
  const done = new Promise((resolve) => (reported = resolve));
  // The provider holds the stream open after the text, until the proxy aborts it (the client left).
  const p = await startModelProxy({
    policy: codexPolicy({ model: 'session-model', tools: ['lookup'] }),
    hooks: { beforeRequest: async () => {}, afterRequest: async (u) => { reports.push(u); reported(); } },
    model: 'session-model',
    origin: 'https://provider.invalid',
    credential: () => 'provider-secret',
    price: (_model, u) => (u.input + u.output + u.cacheRead) / 1e6,
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(stream)); init.signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }, KEY);
  after(() => p.close());
  await new Promise((resolve) => {
    const { hostname, port } = new URL(p.url);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, accept: 'text/event-stream' } }, (res) => {
      let read = 0;
      // The person stops once the text has reached the harness.
      res.on('data', (chunk) => { read += chunk.length; if (read >= Buffer.byteLength(stream)) { req.destroy(); resolve(); } });
      res.on('error', resolve);
      res.on('close', resolve);
    });
    req.on('error', resolve);
    req.end(JSON.stringify({ ...RECORDED_REQUEST, reasoning: { effort: 'medium', summary: 'auto' }, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }] }));
  });
  await done;
  const [booked] = reports;
  // The host's figure for a stop, as serve's cap counts it on a gpt-5-class model: 20,000 input tokens at $1.25 a million,
  // and what it counts of output plus 1,024 tokens at $10 a million, within the 32,000 the request was sent with.
  const stoppedUsd = (tokens) => 20_000 * 1.25 / 1e6 + Math.min(32_000, tokens + 1_024) * 10 / 1e6;
  const store = (await import('@parcha/agentrun-kernel/testing')).memorySessionStore();
  const booking = await modelPortFor(await store.open('chat:text'), { key: 'chat:text', beforeRequest: () => ({ holdUsd: stoppedUsd(32_000), stoppedUsd }) });
  await booking.models.beforeRequest({ model: 'session-model' });
  await booking.models.afterRequest(booked);
  const nano = (usd) => Math.round(usd * 1e9) / 1e9;
  // All it was sent, and medium's 8,192-token budget less the summary's bytes.
  assert.deepEqual(
    { streamed: booked.stoppedAfterBytes, hidden: booked.stoppedHiddenTokens, reasoning: booked.stoppedReasoningBytes, counted: nano(booking.spentUsd()) },
    { streamed: Buffer.byteLength(summary) + Buffer.byteLength(text), hidden: 8_192, reasoning: Buffer.byteLength(summary), counted: nano(stoppedUsd(Buffer.byteLength(summary) + Buffer.byteLength(text) + 8_192 - Buffer.byteLength(summary))) },
    'the summary and the text it sent, and the unseen reasoning, count',
  );
});

test("the content a Responses stream shows, as the policy reads each event: answer text, reasoning and tool call arguments count their delta's bytes; the wire's own fields and every other event count none", () => {
  const policy = codexPolicy({ model: 'session-model', tools: [] });
  const event = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}`;
  const bytes = (e) => policy.contentBytesOf?.(e);
  assert.deepEqual(
    [
      bytes(event('response.output_text.delta', { sequence_number: 9, item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'The answer é', logprobs: [], obfuscation: 'Xk3a9QwE' })),
      bytes(event('response.reasoning_summary_text.delta', { item_id: 'rs_1', delta: 'Weighing' })),
      bytes(event('response.reasoning_text.delta', { item_id: 'rs_1', delta: 'step two' })),
      bytes(event('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"q":"x"}' })),
      bytes(event('response.custom_tool_call_input.delta', { item_id: 'ct_1', delta: 'ls -la' })),
      bytes(event('response.created', { response: { id: 'resp_1' } })),
      bytes(event('response.completed', { response: {} })),
    ],
    [Buffer.byteLength('The answer é'), 8, 8, 9, 6, 0, 0],
  );
});

/** The #1592 walk on codex, as the provider streams it: a response.created and a response.in_progress that each echo the
 *  request (its instructions and tool definitions, several kB), then answer text a few characters a delta in the
 *  Responses API's own framing (sequence number, item id, indexes, logprobs, obfuscation), then the person's stop. The
 *  cap holds the request at what is left (5,000 tokens of output here), counts the stop at what it streamed plus 1,024
 *  tokens, and refuses the next request unless 1,024 tokens fit. */
async function codexWalk({ perMillion, cap, chars }) {
  const tools = Array.from({ length: 6 }, (_, i) => ({ type: 'function', name: `tool_${i}`, description: `Tool ${i}: ${'reads a page of the ledger and returns its rows with their dates and amounts. '.repeat(12)}`, parameters: { type: 'object', properties: { path: { type: 'string' }, page: { type: 'number' } }, required: ['path'] } }));
  const echoed = { id: 'resp_1', object: 'response', status: 'in_progress', model: 'session-model', instructions: 'You are a careful bookkeeper. '.repeat(20), tools, reasoning: { effort: 'none' }, output: [], usage: null };
  const text = 'The quarterly figures reconcile once the deferred revenue moves into the period it was earned in. '.repeat(14).slice(0, chars);
  let seq = 0;
  const event = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...extra })}\n\n`;
  const stream = event('response.created', { response: echoed }) + event('response.in_progress', { response: echoed })
    + event('response.output_item.added', { output_index: 1, item: { id: 'msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9', type: 'message', status: 'in_progress', content: [], role: 'assistant' } })
    + event('response.content_part.added', { item_id: 'msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9', output_index: 1, content_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text: '' } })
    + Array.from({ length: Math.ceil(text.length / 3) }, (_, i) => event('response.output_text.delta', { item_id: 'msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9', output_index: 1, content_index: 0, delta: text.slice(i * 3, i * 3 + 3), logprobs: [], obfuscation: 'Xk3a9QwEr' })).join('');
  const reports = [];
  let reported;
  const done = new Promise((resolve) => (reported = resolve));
  const p = await startModelProxy({
    policy: codexPolicy({ model: 'session-model', tools: ['lookup'] }),
    hooks: { beforeRequest: async () => {}, afterRequest: async (u) => { reports.push(u); reported(); } },
    model: 'session-model',
    origin: 'https://provider.invalid',
    credential: () => 'provider-secret',
    price: (_model, u) => (u.input + u.output + u.cacheRead) / 1e6,
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(stream)); init.signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }, KEY);
  after(() => p.close());
  await new Promise((resolve) => {
    const { hostname, port } = new URL(p.url);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, accept: 'text/event-stream' } }, (res) => {
      let read = 0;
      // The person stops once these characters have reached the harness.
      res.on('data', (chunk) => { read += chunk.length; if (read >= Buffer.byteLength(stream)) { req.destroy(); resolve(); } });
      res.on('error', resolve);
      res.on('close', resolve);
    });
    req.on('error', resolve);
    req.end(JSON.stringify({ ...RECORDED_REQUEST, reasoning: { effort: 'none' }, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }] }));
  });
  await done;
  const [booked] = reports;
  const price = (tokens) => tokens * perMillion / 1e6;
  const stoppedUsd = (tokens) => price(Math.min(5_000, tokens + 1_024));
  const store = (await import('@parcha/agentrun-kernel/testing')).memorySessionStore();
  const booking = await modelPortFor(await store.open('chat:walk'), { key: 'chat:walk', beforeRequest: (r) => (r.spentUsd === null || r.spentUsd + price(1_024) > cap ? { refuse: 'spend_cap_reached' } : { holdUsd: cap - r.spentUsd, stoppedUsd }) });
  await booking.models.beforeRequest({ model: 'session-model' });
  await booking.models.afterRequest(booked);
  const nano = (usd) => Math.round(usd * 1e9) / 1e9;
  const goOn = await booking.models.beforeRequest({ model: 'session-model' }).then(() => 'admitted', (error) => `refused: ${error?.message ?? error}`);
  return { wire: Buffer.byteLength(stream), text: Buffer.byteLength(text), seen: { streamed: booked.stoppedAfterBytes, counted: nano(booking.spentUsd()), goOn }, want: { streamed: Buffer.byteLength(text), counted: nano(stoppedUsd(Buffer.byteLength(text))), goOn: 'admitted' } };
}

test("the #1592 walk on codex: a request at $100 a million output tokens under a $0.50 cap, stopped after 1,146 characters of answer text after the stream's echo of the request, counts that text and the allowance, not its whole hold, and the next request ('Go on.') is admitted", async () => {
  const run = await codexWalk({ perMillion: 100, cap: 0.5, chars: 1_146 });
  assert.ok(run.wire > 10 * run.text, `setup: the wire is the provider's framing and echo, ${run.wire} bytes for ${run.text} of text`);
  assert.deepEqual(run.seen, run.want, 'the text it showed and the allowance, $0.217 of the $0.50 cap, and "Go on." goes');
});

test("the #1592 walk on codex at a catalog price: $10 a million output tokens under a $0.05 cap, stopped after 1,170 characters after the echo, counts that text and the allowance, far below its hold, and 'Go on.' is admitted", async () => {
  const run = await codexWalk({ perMillion: 10, cap: 0.05, chars: 1_170 });
  assert.deepEqual(run.seen, run.want, 'the text and the allowance, $0.02194 of the $0.05 cap, and "Go on." goes');
});
