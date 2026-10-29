// The most input tokens a paid request can be billed for, measured by the model proxy before the runner is asked: the
// UTF-8 bytes of the body as it is sent, plus what the policy says the provider adds that the body does not carry. The
// runner hands it to the host's beforeRequest and keeps it on the request's open entry until it answers, so a budget
// can hold every request in flight at its own input bound. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createHarnessRunner, modelPortFor } from '@parcha/agentrun-adapters';
import * as host from '@parcha/agentrun-adapters/host';

const { ProxyRefusal, startModelProxy } = host;
import { fauxAdapter, memorySessionStore } from '@parcha/agentrun-adapters/testing';

const KEY = 'session-key-for-tests';
/** One paid route; `overhead` is what the provider adds for this body, as the policy says. */
const policyWith = (overhead) => ({
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProxyRefusal(400, 'the body is not an object');
    return { ...body, model: 'session-model' };
  },
  usageOf: () => ({ input: 1, output: 1, cacheRead: 0 }),
  ...(overhead === undefined ? {} : { serverInputOverhead: overhead }),
});

/** A proxy whose hooks record what beforeRequest was given, and a provider that records each body exactly as sent. */
async function proxy(t, policy, hooks) {
  const sent = [];
  const before = [];
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
    hooks: hooks ?? { beforeRequest: async (r) => { before.push(r); }, afterRequest: async () => {} },
    fetch: async (_url, init) => { sent.push(init.body); return new Response('data: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
  }, KEY);
  t.after(() => p.close());
  return { p, sent, before };
}

function send(url, body) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

// Dense text: every character several UTF-8 bytes, and runs a tokenizer may not merge. A bound taken from characters
// (pi's 3.5 per token, say) would put each of these far under its bytes.
const DENSE = {
  ascii: 'The quick brown fox jumps over the lazy dog. '.repeat(40),
  cjk: '漢字かな交じり文、한국어 문장, 中文句子。'.repeat(60),
  emoji: '🙂👩🏽‍💻🏳️‍🌈🧪'.repeat(80),
  combining: 'éäô'.repeat(120),
  base64: Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 131 + 7) % 256)).toString('base64'),
};

test("beforeRequest is given inputTokensMax: the UTF-8 bytes of the body exactly as sent, dense text included, never fewer than its characters", async (t) => {
  const { p, sent, before } = await proxy(t, policyWith());
  for (const [kind, text] of Object.entries(DENSE)) {
    const reply = await send(p.url, { model: 'other', input: text });
    assert.equal(reply.status, 200, `${kind}: ${reply.text}`);
  }
  assert.equal(sent.length, Object.keys(DENSE).length);
  for (const [i, kind] of Object.keys(DENSE).entries()) {
    const bytes = Buffer.byteLength(sent[i], 'utf8');
    assert.equal(before[i].inputTokensMax, bytes, `${kind}: the bound is the sent body's UTF-8 bytes`);
    // A byte-level BPE token covers at least one byte, so a body can never be more tokens than this; and the bound is
    // never below the body's characters, the most any tokenizer that never splits a character could make of it.
    assert.ok(before[i].inputTokensMax >= [...sent[i]].length, `${kind}: not below the body's characters`);
  }
  assert.ok(before[1].inputTokensMax > 2 * [...DENSE.cjk].length, 'CJK text is counted at its bytes, about 3 per character');
});

test("the policy's server-side input is added to the body's bytes", async (t) => {
  const { p, sent, before } = await proxy(t, policyWith((body) => (body.tools ? 675 : 0)));
  await send(p.url, { model: 'other', input: 'hi', tools: [{ name: 'lookup' }] });
  await send(p.url, { model: 'other', input: 'hi' });
  assert.deepEqual(before.map((r) => r.inputTokensMax), [Buffer.byteLength(sent[0], 'utf8') + 675, Buffer.byteLength(sent[1], 'utf8')]);
});

test("a policy whose server-side input cannot be read leaves inputTokensMax undefined, never 0, and the host still decides", async (t) => {
  for (const overhead of [() => { throw new Error('unreadable'); }, () => -1, () => 1.5, () => Number.NaN, () => '12']) {
    const { p, before } = await proxy(t, policyWith(overhead));
    await send(p.url, { model: 'other', input: 'hi' });
    assert.equal(before.length, 1, 'the host is still asked');
    assert.ok('inputTokensMax' in before[0] && before[0].inputTokensMax === undefined, `unmeasured for ${overhead}: ${JSON.stringify(before[0])}`);
  }
  assert.equal(host.inputTokensMaxOf?.(policyWith(), {}, '{"a":"é"}'), 10, 'inputTokensMaxOf measures UTF-8 bytes');
});

test("providerInputOverhead holds each provider's figures in one place: Anthropic's tool-use prompt and per-image maximum, OpenAI's per-image maximum, and nothing claimed for an API it does not know", () => {
  assert.equal(typeof host.providerInputOverhead, 'function', 'exported from the host module');
  const of = host.providerInputOverhead;
  assert.deepEqual([
    of('anthropic-messages', { tools: false, images: 0 }),
    of('anthropic-messages', { tools: true, images: 0 }),
    of('anthropic-messages', { tools: true, toolChoice: 'none', images: 0 }),
    of('anthropic-messages', { tools: true, toolChoice: 'any', images: 0 }),
    of('anthropic-messages', { tools: true, toolChoice: 'tool', images: 2 }),
    of('anthropic-messages', { tools: false, images: 1 }),
    of('openai-responses', { tools: true, images: 0 }),
    of('openai-responses', { tools: false, images: 2 }),
    of('azure-openai-responses', { tools: false, images: 1 }),
    of('openai-codex-responses', { tools: false, images: 1 }),
    of('openai-completions', { tools: true, images: 0 }),
    of('openai-completions', { tools: true, toolChoice: 'any', images: 2 }),
  ], [0, 675, 675, 804, 804 + 2 * 4784, 4784, 0, 2 * 73_800, 73_800, 73_800, 0, 2 * 73_800]);
  // The rest of pi's API union, and anything else: no figure, so unmeasured, never 0.
  for (const api of ['mistral-conversations', 'bedrock-converse-stream', 'google-generative-ai', 'google-vertex', 'pi-messages', 'unknown']) assert.equal(of(api, { tools: false, images: 0 }), undefined, `${api}: unknown, never 0`);
  assert.deepEqual([...host.INPUT_OVERHEAD_APIS].sort(), ['anthropic-messages', 'azure-openai-responses', 'openai-codex-responses', 'openai-completions', 'openai-responses']);
  assert.throws(() => of('anthropic-messages', { tools: false, images: -1 }), /not an image count/);
});

test("the faux adapter measures its prompt as a real adapter's proxy measures its body: every request it makes carries a positive inputTokensMax", async () => {
  const asked = [];
  const adapter = fauxAdapter({ script: () => [{ say: 'a' }, { submit: { answer: 'ok' } }] });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), beforeRequest: (r) => { asked.push(r.inputTokensMax); } });
  await runWorkflow({ v: 2, name: 'faux-bound', schemas: { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } }, output: { schemaId: 'Out', path: 'final' }, root: { node: 'agent', label: 'task', instructions: 'Say ok, in a line of plain words.', out: 'Out', as: 'final' } }, {}, { runNode });
  assert.ok(asked.length >= 2, `asked ${asked.length} times`);
  for (const n of asked) assert.ok(Number.isSafeInteger(n) && n > 'Say ok, in a line of plain words.'.length, `measured, at least the prompt's bytes: ${n}`);
});

test("the runner gives the host each request's inputTokensMax and keeps it on the request's open entry until it answers", async () => {
  const asked = [];
  const booking = await modelPortFor(await memorySessionStore().open('chat:bound'), { key: 'chat:bound', budgetUsd: 1, beforeRequest: (r) => { asked.push(r); } });
  const first = await booking.models.beforeRequest({ model: 'm', inputTokensMax: 1234 });
  const second = await booking.models.beforeRequest({ model: 'm' });
  await booking.models.beforeRequest({ model: 'm', inputTokensMax: 77 });
  assert.deepEqual(asked.map((r) => [r.turn, r.inputTokensMax, r.inFlight]), [
    [1, 1234, []],
    [2, undefined, [{ turn: 1, model: 'm', inputTokensMax: 1234 }]],
    [3, 77, [{ turn: 1, model: 'm', inputTokensMax: 1234 }, { turn: 2, model: 'm', inputTokensMax: undefined }]],
  ]);
  await booking.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 }, first);
  await booking.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 }, second);
  await booking.models.beforeRequest({ model: 'm', inputTokensMax: 5 });
  assert.deepEqual(asked.at(-1).inFlight, [{ turn: 3, model: 'm', inputTokensMax: 77 }], 'an answered request no longer holds its bound');
});

test("through the proxy and the runner, the host's beforeRequest sees the sent body's bound, and a host that finds it over what is left refuses it before it is sent", async (t) => {
  const asked = [];
  // A host whose budget has room for fewer input tokens than this body's bytes: it refuses on the bound alone.
  const room = 200;
  const booking = await modelPortFor(await memorySessionStore().open('chat:cap'), {
    key: 'chat:cap',
    beforeRequest: (r) => { asked.push(r); if (r.inputTokensMax === undefined || r.inputTokensMax > room) return { refuse: `input of up to ${r.inputTokensMax} tokens exceeds what is left` }; },
  });
  const { p, sent } = await proxy(t, policyWith(), { beforeRequest: (r) => booking.models.beforeRequest(r), afterRequest: (u, ticket) => booking.models.afterRequest(u, ticket) });
  const small = await send(p.url, { model: 'other', input: 'hi' });
  const large = await send(p.url, { model: 'other', input: DENSE.cjk });
  assert.equal(small.status, 200, small.text);
  assert.equal(large.status, 400, large.text);
  assert.equal(sent.length, 1, 'the provider never saw the request over the cap');
  assert.deepEqual(asked.map((r) => r.inputTokensMax > room), [false, true]);
});
