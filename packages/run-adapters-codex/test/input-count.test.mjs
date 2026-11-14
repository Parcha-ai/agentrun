// A Codex request's input bound. Through any route it is the body's bytes less the escapes JSON adds to the text the
// model reads as it is (a tool's output, a message, a call's arguments), every other byte counted as sent. On a route
// straight to OpenAI (`https://api.openai.com`) it is also OpenAI's own count of it (POST /v1/responses/input_tokens)
// when that is lower, asked with only the credential's headers; through a gateway (OpenRouter) or any other base the
// byte bound stands, and a count that fails, times out or answers anything else leaves the byte bound too. No network:
// OpenAI is a scripted fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';
import { codexPolicy } from '../dist/host/policy.js';

const { startModelProxy, responsesEscapedBytes } = host;
const { inputTokensMaxOf } = await import('@parcha/agentrun-kernel/testing');
const KEY = 'session-key-for-tests';
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const RECORDED_REQUEST = JSON.parse(fixture('roundtrip-request-3.json'));
const RECORDED_STREAM = fixture('responses-stream-recorded.sse');
const options = { model: 'gpt-6.1-sol', tools: ['lookup', 'submit'] };
const policy = codexPolicy(options);
const ROUTE = policy.routes.find((r) => r.path === '/v1/responses');

/** A fetched page as a code-mode script prints it: JSON, quotes and newlines that the body escapes once more. */
const PAGE = JSON.stringify([{ url: 'https://registry.example/yaml', status: 200, content: '{\n  "name": "yaml",\n  "version": "2.9.1",\n  "description": "JavaScript parser and stringifier for YAML"\n}\n'.repeat(40) }]);
/** A code-mode request: Codex's prompt and tools, an exec with its output, encrypted reasoning, and the exec tool's
 *  own definition in an `additional_tools` item whose strings carry quotes and newlines too. */
const codeMode = {
  ...RECORDED_REQUEST,
  parallel_tool_calls: false,
  input: [
    ...RECORDED_REQUEST.input,
    { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: 'Run a script.\nSay "done" when\tit ends.' }] }] },
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Reading the "registry".\n' }], encrypted_content: 'gAAAAABo'.repeat(400) },
    { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'call_exec_1', name: 'exec', input: 'const r = await tools.web_fetch({ url: "https://registry.example/yaml" });\nconsole.log(JSON.stringify([r]));' },
    { type: 'custom_tool_call_output', call_id: 'call_exec_1', output: [{ type: 'input_text', text: `Script completed\nOutput:\n${PAGE}` }] },
  ],
};

const bytes = (value) => Buffer.byteLength(value, 'utf8');
/** What JSON's escapes add to `text`, as the body spells it. */
const escapes = (text) => bytes(JSON.stringify(text)) - 2 - bytes(text);
const shaped = (body) => policy.apply(structuredClone(body), ROUTE);

test("the input bound counts the text the model reads at its own bytes, not its escaped ones; tools, encrypted reasoning and structure stay as sent", () => {
  const body = shaped(codeMode);
  const sent = JSON.stringify(body);
  const texts = [
    ...RECORDED_REQUEST.input.flatMap((item) => item.type === 'message' ? item.content.map((part) => part.text) : item.type === 'function_call' ? [item.arguments] : item.type === 'function_call_output' ? [item.output] : []),
    'Reading the "registry".\n',
    codeMode.input.at(-2).input,
    codeMode.input.at(-1).output[0].text,
  ];
  const saved = texts.reduce((n, text) => n + escapes(text), 0);
  assert.ok(saved > 1_000, `the exec's printed JSON is escaped once more in the body (${saved} of ${bytes(sent)} bytes)`);
  assert.equal(responsesEscapedBytes(body), saved, 'exactly the escapes of the text the model reads, nothing of the tool definitions or the encrypted reasoning');
  assert.equal(inputTokensMaxOf(policy, body, sent), bytes(sent) - saved, 'the body less those escapes');
  // Never below the text itself plus every byte that is not that text's spelling: the decoded text is all it gave up.
  const textBytes = texts.reduce((n, text) => n + bytes(text), 0);
  const spelled = texts.reduce((n, text) => n + bytes(JSON.stringify(text)) - 2, 0);
  assert.equal(inputTokensMaxOf(policy, body, sent), textBytes + (bytes(sent) - spelled));
  // A tool definition's quotes and newlines (here, inside the additional_tools item) and the top-level tools keep their bytes.
  const withoutTools = { ...body, tools: [], input: body.input.filter((item) => item.type !== 'additional_tools') };
  assert.equal(responsesEscapedBytes(withoutTools), saved, 'tool definitions give up nothing');
});

test("a body whose text has nothing to escape keeps its bytes exactly; a file input still has no bound", () => {
  const plain = shaped({ ...RECORDED_REQUEST, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look up the capital of France.' }] }] });
  const sent = JSON.stringify(plain);
  assert.equal(inputTokensMaxOf(policy, plain, sent), bytes(sent));
  const file = shaped({ ...RECORDED_REQUEST, input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=' }] }] });
  assert.equal(inputTokensMaxOf(policy, file, JSON.stringify(file)), undefined, 'unmeasured, never its bytes');
});

function send(url, body) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, accept: 'text/event-stream' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** A proxy on `origin` under `policyNow`: `count(init)` answers an input_tokens request as OpenAI would. Every request the
 *  provider got is kept, the counts apart, with what the host was asked. */
async function proxyOn(t, origin, { count = async () => Response.json({ object: 'response.input_tokens', input_tokens: 2_000 }), policyNow = policy, headers } = {}) {
  const counts = [];
  const sent = [];
  const asked = [];
  const said = [];
  const p = await startModelProxy({
    policy: policyNow, model: 'gpt-6.1-sol', origin, credential: () => 'provider-secret', price: () => 0.001, log: (message) => said.push(message), ...(headers ? { headers } : {}),
    hooks: { beforeRequest: async (r) => { asked.push(r); }, afterRequest: async () => {} },
    fetch: async (url, init) => {
      if (String(url).endsWith('/input_tokens')) {
        counts.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) });
        return count(init);
      }
      sent.push(String(url));
      return new Response(RECORDED_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  }, KEY);
  t.after(() => p.close());
  return { p, counts, sent, asked, said };
}

test("straight to OpenAI, a Codex request's input bound is OpenAI's count of it, asked with only the credential and account headers and the fields it counts", async (t) => {
  const { p, counts, asked, sent } = await proxyOn(t, 'https://api.openai.com', { headers: { 'OpenAI-Project': 'proj_test' } });
  assert.equal((await send(p.url, codeMode)).status, 200);
  assert.equal((await send(p.url, codeMode)).status, 200);
  assert.deepEqual(asked.map((r) => [r.inputTokensMax, r.inputTokensCounted]), [[2_000, true], [2_000, true]], 'each answer request is counted, and marked so');
  assert.deepEqual(sent, ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses'], 'each request went on');
  assert.equal(counts.length, 2);
  assert.equal(counts[0].url, 'https://api.openai.com/v1/responses/input_tokens');
  assert.deepEqual(Object.keys(counts[0].headers).map((n) => n.toLowerCase()).sort(), ['authorization', 'content-type', 'openai-project']);
  assert.equal(counts[0].headers.authorization, 'Bearer provider-secret');
  assert.deepEqual(Object.keys(counts[0].body).sort(), ['input', 'model', 'parallel_tool_calls', 'reasoning', 'tool_choice', 'tools'], 'never stream, store, include, max_output_tokens or the cache key');
  assert.equal(counts[0].body.model, 'gpt-6.1-sol');
  assert.deepEqual(counts[0].body.input, shaped(codeMode).input, 'the input as the request sends it');
});

test("a count that fails, says no count, answers in another shape, or is above the bytes leaves the byte bound; the request still goes", async (t) => {
  const body = shaped(codeMode);
  const byteBound = inputTokensMaxOf(policy, body, JSON.stringify(body));
  const answers = {
    'a 500': async () => new Response('{"error":{"message":"no"}}', { status: 500 }),
    'a refused fetch': async () => { throw new Error('connection refused'); },
    'an empty answer': async () => Response.json({}),
    'another object': async () => Response.json({ object: 'list', input_tokens: 5 }),
    'a negative count': async () => Response.json({ object: 'response.input_tokens', input_tokens: -1 }),
    'not JSON': async () => new Response('event: nope\n\n', { status: 200 }),
    'a count above its bytes': async () => Response.json({ object: 'response.input_tokens', input_tokens: 10_000_000 }),
  };
  for (const [name, count] of Object.entries(answers)) {
    const { p, asked, sent, counts } = await proxyOn(t, 'https://api.openai.com', { count });
    assert.equal((await send(p.url, codeMode)).status, 200, name);
    assert.equal(counts.length, 1, `${name}: asked once`);
    assert.deepEqual([asked[0].inputTokensMax, asked[0].inputTokensCounted, sent.length], [byteBound, undefined, 1], `${name}: the byte bound, and the request went`);
  }
});

test("a count that takes longer than its timeout leaves the byte bound", async (t) => {
  const body = shaped(codeMode);
  const { p, asked } = await proxyOn(t, 'https://api.openai.com', {
    count: (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
  });
  assert.equal((await send(p.url, codeMode)).status, 200);
  assert.deepEqual([asked[0].inputTokensMax, asked[0].inputTokensCounted], [inputTokensMaxOf(policy, body, JSON.stringify(body)), undefined]);
});

test("through a gateway (OpenRouter) or any other base the request is never counted: the key and the body go nowhere the request does not", async (t) => {
  const body = shaped(codeMode);
  for (const origin of ['https://openrouter.ai/api', 'https://api.openai.com.example', 'https://gateway.example/openai', 'http://api.openai.com']) {
    const { p, counts, asked } = await proxyOn(t, origin);
    assert.equal((await send(p.url, codeMode)).status, 200, origin);
    assert.deepEqual([counts.length, asked[0].inputTokensMax, asked[0].inputTokensCounted], [0, inputTokensMaxOf(policy, body, JSON.stringify(body)), undefined], origin);
  }
});

test("a body that offers Codex's live web search has no input bound, and is never counted into one", async (t) => {
  const live = JSON.parse(fixture('responses-request-web-search-live.json'));
  const searching = codexPolicy({ ...options, webSearch: 'live', searchAllowed: async () => true });
  const { p, counts, asked } = await proxyOn(t, 'https://api.openai.com', { policyNow: searching });
  const reply = await send(p.url, live);
  assert.equal(asked.length, 1, reply.text);
  assert.deepEqual([asked[0].inputTokensMax, asked[0].inputTokensCounted, counts.length], [undefined, undefined, 0]);
});
