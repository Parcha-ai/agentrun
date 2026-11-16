// A Codex request's input bound. Through any route it is the body's bytes less the escapes JSON adds to the text the
// model reads as it is (a tool's output, a message, a call's arguments), every other byte counted as sent. On every
// route, straight to OpenAI (`https://api.openai.com`), through a gateway (OpenRouter) or any other base, the bound is
// the kernel's local count (o200k_base and its margin) when that is lower, and nothing is asked of the provider before
// the request: no count request, no wait on one. A tight cap is decided on that count. No network: OpenAI is a
// scripted fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';
import { codexPolicy } from '../dist/host/policy.js';

const { startModelProxy, responsesEscapedBytes, responsesLocalInputTokens } = host;
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

/** Sol as the cap prices it (USD per million tokens). */
const SOL = Object.freeze({ id: 'gpt-6.1-sol', api: 'openai-responses', price: { input: 2, output: 10, cacheRead: 0.2 }, outputCeiling: 128_000, reasoning: true });
const priceOf = (_model, usage) => (usage.input * SOL.price.input + usage.output * SOL.price.output + usage.cacheRead * SOL.price.cacheRead) / 1e6;

/** A proxy on `origin` under `policyNow`, its host's admission `admit` (none: every request goes). Every request the
 *  provider got is kept, any count request apart (an input_tokens path, answered as OpenAI would), with what the host
 *  was asked and what it booked. */
async function proxyOn(t, origin, { policyNow = policy, admit = async () => undefined } = {}) {
  const counts = [];
  const sent = [];
  const asked = [];
  const booked = [];
  const p = await startModelProxy({
    policy: policyNow, model: 'gpt-6.1-sol', origin, credential: () => 'provider-secret', price: priceOf, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r); return admit(r); }, afterRequest: async (usage) => { booked.push(usage); } },
    fetch: async (url) => {
      if (String(url).endsWith('/input_tokens')) {
        counts.push(String(url));
        return Response.json({ object: 'response.input_tokens', input_tokens: 2_000 });
      }
      sent.push(String(url));
      return new Response(RECORDED_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  }, KEY);
  t.after(() => p.close());
  return { p, counts, sent, asked, booked };
}

test("on every route, straight to OpenAI included, a Codex request's input bound is its local count, and nothing is asked of the provider before it", async (t) => {
  assert.equal(policy.countInput, undefined, 'the policy names no provider count');
  const body = shaped(codeMode);
  const local = await responsesLocalInputTokens(body);
  assert.ok(local < inputTokensMaxOf(policy, body, JSON.stringify(body)));
  for (const origin of ['https://api.openai.com', 'https://openrouter.ai/api', 'https://api.openai.com.example', 'https://gateway.example/openai', 'http://api.openai.com']) {
    const { p, counts, asked, sent } = await proxyOn(t, origin);
    assert.equal((await send(p.url, codeMode)).status, 200, origin);
    assert.equal((await send(p.url, codeMode)).status, 200, origin);
    assert.deepEqual(asked.map((r) => r.inputTokensMax), [local, local], `${origin}: each answer request at its local count`);
    assert.ok(asked.every((r) => !('inputTokensCounted' in r)), 'and not marked: the cap prices every input uncached');
    assert.deepEqual([counts, sent.length], [[], 2], `${origin}: no count request, each answer request sent`);
  }
});

test("a tight cap is decided on the local count alone: at the least it needs the request goes and is booked within it, a hair below it is refused unsent, and no count request is made either way", async (t) => {
  const { beforeRequestOf } = await import('@parcha/agentrun-kernel/kernel/cap');
  const body = shaped(codeMode);
  const local = await responsesLocalInputTokens(body);
  const byteBound = inputTokensMaxOf(policy, body, JSON.stringify(body));
  const verdictAt = (capUsd, r) => beforeRequestOf({ capUsd: () => capUsd, modelOf: (id) => (id === SOL.id ? SOL : undefined) })({ ...r, turn: 1, spentUsd: 0, inFlight: [] });
  const refused = (verdict) => verdict !== undefined && 'refuse' in verdict;
  // What the proxy hands the host for this body, and the least cap that admits it (to a billionth of a dollar).
  const probe = await proxyOn(t, 'https://api.openai.com');
  assert.equal((await send(probe.p.url, codeMode)).status, 200);
  const request = probe.asked[0];
  assert.equal(request.inputTokensMax, local);
  let [low, high] = [0, 10];
  while (high - low > 1e-9) { const mid = (low + high) / 2; if (refused(verdictAt(mid, request))) low = mid; else high = mid; }
  const least = high;
  assert.ok(refused(verdictAt(least, { ...request, inputTokensMax: byteBound })), `the byte bound (${byteBound} tokens) would not fit $${least}: the local count (${local}) is what lets it through`);
  const admit = (capUsd) => async (r) => {
    const verdict = verdictAt(capUsd, r);
    if (refused(verdict)) throw new Error(verdict.refuse);
    return verdict;
  };
  const tight = await proxyOn(t, 'https://api.openai.com', { admit: admit(least) });
  const went = await send(tight.p.url, codeMode);
  assert.equal(went.status, 200, went.text);
  assert.deepEqual([tight.counts, tight.sent.length], [[], 1], 'sent at the least cap, with no count request');
  assert.equal(tight.booked.length, 1);
  assert.ok(tight.booked[0].usd <= least, `booked $${tight.booked[0].usd}, within the cap of $${least}`);
  const below = await proxyOn(t, 'https://api.openai.com', { admit: admit(least - 2e-9) });
  const stopped = await send(below.p.url, codeMode);
  assert.notEqual(stopped.status, 200);
  assert.match(stopped.text, /refused before it was sent/);
  assert.deepEqual([below.counts, below.sent], [[], []], 'refused unsent, with no count request');
});

test("a plan request is never counted, locally or by OpenAI: it is held at $0", () => {
  const plan = codexPolicy({ ...options, plan: true });
  assert.equal(plan.countInputLocally, undefined);
  assert.equal(plan.countInput, undefined);
});

test("a body that offers Codex's live web search has no input bound, and is never counted into one", async (t) => {
  const live = JSON.parse(fixture('responses-request-web-search-live.json'));
  const searching = codexPolicy({ ...options, webSearch: 'live', searchAllowed: async () => true });
  const { p, counts, asked } = await proxyOn(t, 'https://api.openai.com', { policyNow: searching });
  const reply = await send(p.url, live);
  assert.equal(asked.length, 1, reply.text);
  assert.deepEqual([asked[0].inputTokensMax, counts.length], [undefined, 0]);
});
