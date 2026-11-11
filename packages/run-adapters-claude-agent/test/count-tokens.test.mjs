// A request's input bound on a route straight to Anthropic is Anthropic's own count of it (POST /v1/messages/count_tokens,
// free) when that is below its bytes, so a small cap admits a first turn its bytes would not. The count is asked only of
// Anthropic's own origin, with only the credential and version headers; through a gateway (OpenRouter) or any other base
// the byte bound stands, and a count that fails, times out or says nothing leaves the byte bound too. No network: the
// provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';
import { anthropicPolicy } from '@parcha/agentrun-harness-claude';
import { applyAnthropic } from '../dist/host/policy.js';

const { startModelProxy } = host;
const { beforeRequestOf } = await import('@parcha/agentrun-kernel/kernel/cap');

const options = { model: 'claude-main', smallModel: 'claude-small', tools: ['lookup'], maxOutputTokens: 8_000 };
const policy = anthropicPolicy(options);
const MESSAGES = policy.routes.find((r) => r.path === '/v1/messages');
const tool = { name: 'mcp__hands__lookup', description: 'Look a fact up.', input_schema: { type: 'object', properties: { q: { type: 'string' } } } };
/** A first turn whose system prompt is about 24 KB of plain text: some 6,000 tokens, read by its bytes as 24,000. */
const SYSTEM = 'You are an agent with a work folder and tools. Follow the plan and report what you did. '.repeat(280);
const firstTurn = { model: 'claude-main', max_tokens: 1024, system: SYSTEM, tools: [tool], messages: [{ role: 'user', content: 'Look up the capital of France.' }] };
/** The tool-use system prompt Claude adds for tools at auto. */
const PROMPT = 675;
const ANSWER = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-main","content":[],"stop_reason":null,"usage":{"input_tokens":6000,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

function send(url, body) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/messages?beta=true', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** A proxy on `origin` under the Claude policy: `count(init)` answers a count_tokens request; `admit(request)` is the
 *  host's beforeRequest (a throw refuses). Every request the provider got is kept, the counts apart. */
async function proxyOn(t, origin, { count = async () => Response.json({ input_tokens: 6_000 }), admit = async () => {} } = {}) {
  const counts = [];
  const sent = [];
  const asked = [];
  const p = await startModelProxy({
    policy, model: 'claude-main', origin, credential: () => 'provider-secret', price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r.inputTokensMax); await admit(r); }, afterRequest: async () => {} },
    fetch: async (url, init) => {
      if (String(url).endsWith('/count_tokens')) {
        counts.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) });
        return count(init);
      }
      sent.push(init.body);
      return new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  }, 'session-key');
  t.after(() => p.close());
  return { p, counts, sent, asked };
}

const bytesOf = (body) => Buffer.byteLength(JSON.stringify(applyAnthropic(body, MESSAGES, options)), 'utf8');

test("straight to Anthropic, a request's input bound is Anthropic's count of it (and the tool-use prompt), never its bytes; each answer request is counted", async (t) => {
  const { p, counts, asked, sent } = await proxyOn(t, 'https://api.anthropic.com');
  assert.equal((await send(p.url, firstTurn)).status, 200);
  assert.equal((await send(p.url, firstTurn)).status, 200);
  assert.deepEqual(asked, [6_000 + PROMPT, 6_000 + PROMPT], `counted, against ${bytesOf(firstTurn) + PROMPT} by its bytes`);
  assert.equal(sent.length, 2, 'each request went on');
  assert.equal(counts.length, 2);
  // Only Anthropic's own endpoint, with the credential and the version, and only the fields it counts.
  assert.equal(counts[0].url, 'https://api.anthropic.com/v1/messages/count_tokens');
  assert.deepEqual(Object.keys(counts[0].headers).map((n) => n.toLowerCase()).sort(), ['anthropic-version', 'content-type', 'x-api-key']);
  assert.equal(counts[0].headers['x-api-key'], 'provider-secret');
  assert.deepEqual(Object.keys(counts[0].body).sort(), ['messages', 'model', 'system', 'tools']);
});

test("a count above the request's bytes is not taken: the bound is the lower of the two", async (t) => {
  const { p, asked } = await proxyOn(t, 'https://api.anthropic.com', { count: async () => Response.json({ input_tokens: 10_000_000 }) });
  await send(p.url, firstTurn);
  assert.deepEqual(asked, [bytesOf(firstTurn) + PROMPT]);
});

test("a count that fails, throws, times out or says no count leaves the byte bound, and the request still goes", async (t) => {
  const failures = {
    status: async () => new Response('overloaded', { status: 529 }),
    throws: async () => { throw new Error('connection reset'); },
    timeout: async (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
    garbage: async () => new Response('not json', { status: 200 }),
    noCount: async () => Response.json({ input_tokens: -1 }),
  };
  for (const [name, count] of Object.entries(failures)) {
    if (name === 'timeout') continue; // its own case below, on a short timeout
    const { p, asked, sent } = await proxyOn(t, 'https://api.anthropic.com', { count });
    assert.equal((await send(p.url, firstTurn)).status, 200, name);
    assert.deepEqual([asked, sent.length], [[bytesOf(firstTurn) + PROMPT], 1], name);
  }
  // A count that never answers is given up at its timeout (here 50 ms), and the bound is the bytes'.
  const said = [];
  const counted = await host.countedInputOf(policy, 'https://api.anthropic.com', applyAnthropic(firstTurn, MESSAGES, options), { 'x-api-key': 'k' }, (url, init) => failures.timeout(init), (message) => said.push(message), 50);
  assert.equal(counted, undefined);
  assert.match(said.join('\n'), /token count failed; the request keeps its byte bound/);
});

test("through a gateway (OpenRouter) or any other base, nothing is counted: the byte bound stands and the key goes only where the request goes", async (t) => {
  for (const origin of ['https://openrouter.ai/api', 'https://api.anthropic.com.example.net', 'https://gateway.example/anthropic']) {
    const { p, counts, asked } = await proxyOn(t, origin);
    assert.equal((await send(p.url, firstTurn)).status, 200, origin);
    assert.deepEqual([counts.length, asked], [0, [bytesOf(firstTurn) + PROMPT]], origin);
  }
});

test("under a $0.05 cap on Sonnet, a small first turn straight to Anthropic is sent (counted); through OpenRouter its bytes refuse it", async (t) => {
  const sonnet = { id: 'claude-main', api: 'anthropic-messages', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 };
  const before = beforeRequestOf({ capUsd: () => 0.05, modelOf: (id) => (id === sonnet.id ? sonnet : undefined) });
  const admit = async (r) => {
    const verdict = before({ model: r.model, turn: 1, spentUsd: 0, inFlight: [], inputTokensMax: r.inputTokensMax, outputTokensAsked: r.outputTokensAsked, outputTokensLeast: r.outputTokensLeast });
    if (verdict && 'refuse' in verdict) throw new Error(verdict.refuse);
  };
  const direct = await proxyOn(t, 'https://api.anthropic.com', { admit });
  const sentDirect = await send(direct.p.url, firstTurn);
  assert.equal(sentDirect.status, 200, sentDirect.text);
  const gateway = await proxyOn(t, 'https://openrouter.ai/api', { admit });
  const refused = await send(gateway.p.url, firstTurn);
  assert.notEqual(refused.status, 200, 'its 24 KB of bytes read as 24,000 tokens do not fit $0.05');
  assert.match(refused.text, /needs at least/);
});
