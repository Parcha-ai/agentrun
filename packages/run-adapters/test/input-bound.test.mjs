// The most input tokens a paid request can be billed for, measured by the model proxy before the runner is asked: the
// UTF-8 bytes of the body as it is sent, plus what the policy says the provider adds that the body does not carry. The
// runner hands it to the host's beforeRequest and keeps it on the request's open entry until it answers, so a budget
// can hold every request in flight at its own input bound. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createHarnessRunner, modelPortFor } from '@parcha/agentrun-kernel';
import * as host from '@parcha/agentrun-kernel/host';

const { ProxyRefusal, startModelProxy } = host;
import { fauxAdapter, inputTokensMaxOf, memorySessionStore } from '@parcha/agentrun-kernel/testing';

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
  // Below 0 is a figure (images' data counted at their billed size instead), but never past the body's bytes.
  for (const overhead of [() => { throw new Error('unreadable'); }, () => undefined, () => null, () => -1_000_000, () => 1.5, () => Number.NaN, () => Number.POSITIVE_INFINITY, () => '12']) {
    const { p, before } = await proxy(t, policyWith(overhead));
    await send(p.url, { model: 'other', input: 'hi' });
    assert.equal(before.length, 1, 'the host is still asked');
    assert.ok('inputTokensMax' in before[0] && before[0].inputTokensMax === undefined, `unmeasured for ${overhead}: ${JSON.stringify(before[0])}`);
  }
  assert.equal(inputTokensMaxOf(policyWith(), {}, '{"a":"é"}'), 10, 'inputTokensMaxOf measures UTF-8 bytes');
  // Only a policy with no hook at all adds nothing; a hook that answers undefined or null has not measured.
  assert.deepEqual([inputTokensMaxOf(policyWith(() => undefined), {}, '{}'), inputTokensMaxOf(policyWith(() => null), {}, '{}'), inputTokensMaxOf(policyWith(), {}, '{}')], [undefined, undefined, 2]);
});

test("an undefined overhead is the policy's word that the body has no input bound: the proxy sends it with inputTokensMax undefined, never 0 or the body's bytes, and reports no failure; null or a throw is still reported", async (t) => {
  const { p, sent, before } = await proxy(t, policyWith(() => undefined));
  await send(p.url, { model: 'other', input: 'hi' });
  assert.equal(sent.length, 1, 'the request is still sent');
  assert.ok('inputTokensMax' in before[0] && before[0].inputTokensMax === undefined, JSON.stringify(before[0]));
  const said = [];
  const say = (message) => said.push(message);
  assert.equal(inputTokensMaxOf(policyWith(() => undefined), {}, '{"a":"é"}', say), undefined);
  assert.deepEqual(said, [], 'no bound is an answer, not a failure');
  for (const overhead of [() => null, () => { throw new Error('unreadable'); }]) assert.equal(inputTokensMaxOf(policyWith(overhead), {}, '{}', say), undefined);
  assert.equal(said.length, 2, 'a figure that could not be read is reported');
  assert.equal(inputTokensMaxOf(policyWith(() => 0), {}, '{"a":"é"}', say), 10, 'a 0 is a figure: the bytes alone');
  assert.equal(inputTokensMaxOf(policyWith(() => -4), {}, '{"a":"é"}', say), 6, 'below 0 is a figure: bytes billed apart, at a size below their bytes');
  assert.equal(inputTokensMaxOf(policyWith(() => -11), {}, '{"a":"é"}', say), undefined, 'never below the body\'s bytes');
});

/** `n` images whose data is not in the body (a URL the provider fetches), of no size the bound can read. */
const unsized = (n) => Array.from({ length: n }, () => ({ bytes: 0 }));

test("providerInputOverhead holds each provider's figures in one place: Anthropic's tool-use prompt and per-image maximum, and OpenAI's per-image maximum", () => {
  assert.equal(typeof host.providerInputOverhead, 'function', 'exported from the host module');
  const of = host.providerInputOverhead;
  assert.deepEqual([
    of('anthropic-messages', { tools: false, images: [] }),
    of('anthropic-messages', { tools: true, images: [] }),
    of('anthropic-messages', { tools: true, toolChoice: 'none', images: [] }),
    of('anthropic-messages', { tools: true, toolChoice: 'any', images: [] }),
    of('anthropic-messages', { tools: true, toolChoice: 'tool', images: unsized(2), model: 'claude-sonnet-5-5' }),
    of('anthropic-messages', { tools: false, images: unsized(1), model: 'anthropic/claude-sonnet-5.5' }),
    of('anthropic-messages', { tools: false, images: unsized(1) }),
    of('anthropic-messages', { tools: false, images: unsized(1), model: 'openai/gpt-5' }),
    of('openai-responses', { tools: true, images: [] }),
    of('openai-responses', { tools: false, images: unsized(2), model: 'gpt-5.1-codex' }),
    of('azure-openai-responses', { tools: false, images: unsized(1) }),
    of('openai-codex-responses', { tools: false, images: unsized(1) }),
  ], [0, 675, 675, 804, 804 + 2 * 4784, 4784, 73_800, 73_800, 0, 2 * 73_800, 73_800, 73_800]);
  assert.deepEqual([...host.INPUT_OVERHEAD_APIS].sort(), ['anthropic-messages', 'azure-openai-responses', 'openai-codex-responses', 'openai-completions', 'openai-responses']);
  for (const images of [1, [{ bytes: -1 }], [{ bytes: 1.5 }], [{ bytes: 0, width: 10 }], [{ bytes: 0, width: 0, height: 10 }]]) {
    assert.throws(() => of('anthropic-messages', { tools: false, images }), /not (a list of images|an image's bytes and size)/, JSON.stringify(images));
  }
});

test("an image is counted at what the routed model's provider bills it as by its size, whatever API carries it, in place of the bytes its data takes in the body; a provider of no known rule gets the most of the three rules", () => {
  const of = host.providerInputOverhead;
  const screen = { bytes: 1_300_000, width: 1280, height: 720 };
  assert.deepEqual(['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5', 'openai/gpt-5', 'gpt-4o-mini', 'o4-mini', 'gpt-5.1-codex', 'google/gemini-3-pro', 'gemini-2.5-flash', 'meta-llama/llama-4', 'faux-model', undefined].map(host.imageProviderOf),
    ['anthropic', 'anthropic', 'openai', 'openai', 'openai', 'openai', 'google', 'google', undefined, undefined, undefined]);
  // OpenAI: 1280x720 is 1365x768 with its shorter side at 768, 3 x 2 tiles: 85 + 6 x 170 = 1,105; its 40 x 23 patches at
  // 2.46: 2,264.
  assert.equal(host.openaiImageTokens(1280, 720, 'gpt-5'), 1105, 'a tile-billed model: its tiles alone, far under the 73,800 maximum');
  assert.equal(host.openaiImageTokens(1280, 720, 'openai/gpt-5', 'low'), 85, 'detail low: 85 whatever its size');
  assert.equal(host.openaiImageTokens(1280, 720, 'gpt-5', 'auto'), 1105, 'detail auto may choose high');
  assert.deepEqual(['gpt-4.1-nano', 'o4-mini', 'codex-mini-latest', 'gpt-4.1-mini', 'gpt-5', 'gpt-5.1-codex'].map((m) => host.openaiImageTokens(1280, 720, m)), [2264, 1583, 1583, 1491, 1105, 1105], 'patch-billed models at their multipliers, above their tiles');
  assert.equal(host.openaiImageTokens(1280, 720), 2264, 'no model named: every rule, the patches at 2.46');
  assert.equal(host.openaiImageTokens(1280, 720, 'gpt-4o-mini'), 2833 + 6 * 5667, 'gpt-4o-mini\'s tiles');
  assert.equal(host.openaiImageTokens(1280, 720, 'gpt-4o-mini', 'low'), 2833, 'gpt-4o-mini at detail low');
  assert.equal(host.openaiImageTokens(100, 100), 765, 'its shorter side brought to 768 either way: 2 x 2 tiles, above its 16 patches');
  assert.equal(host.openaiImageTokens(20_000, 20_000), 73_800, 'at most the per-image maximum');
  // Gemini: 258 a 768 px tile (2 x 1 for 1280x720 = 516), or 258 for one at most 384 px; at least Gemini 3's 1,120.
  assert.deepEqual([host.geminiImageTokens(1280, 720), host.geminiImageTokens(300, 300), host.geminiImageTokens(4000, 4000)], [1120, 1120, 258 * 36]);
  assert.deepEqual([
    of('anthropic-messages', { tools: false, images: [screen], model: 'anthropic/claude-sonnet-5.5' }),
    of('anthropic-messages', { tools: false, images: [screen], model: 'openai/gpt-5' }),
    of('anthropic-messages', { tools: false, images: [screen], model: 'google/gemini-3-pro' }),
    of('anthropic-messages', { tools: false, images: [screen], model: 'meta-llama/llama-4' }),
    of('openai-completions', { tools: false, images: [screen], model: 'anthropic/claude-sonnet-5.5' }),
    of('openai-responses', { tools: false, images: [{ bytes: 900 }], model: 'gpt-5' }),
  ], [1229 - 1_300_000, 1105 - 1_300_000, 1120 - 1_300_000, 2264 - 1_300_000, 1229 - 1_300_000, 73_800 - 900], 'never the image\'s bytes; an unread size at the largest maximum');
});

test("Claude's rule by an image's size", () => {
  assert.equal(host.anthropicImageTokens(1280, 720), 1229, 'its area: 921,600 / 750, above its 46 x 26 = 1,196 patches');
  assert.equal(host.anthropicImageTokens(1000, 1000), 1334, 'the more of its 36 x 36 = 1,296 patches and its 1,334 by area');
  assert.equal(host.anthropicImageTokens(29, 29), 4, 'its 2 x 2 patches, above its 2 by area');
  assert.equal(host.anthropicImageTokens(8000, 8000), 4784, 'at most the high-resolution tier\'s maximum');
  assert.equal(host.anthropicImageTokens(1, 1), 1);
  const of = host.providerInputOverhead;
  const claude = 'claude-sonnet-5-5';
  assert.deepEqual([
    of('anthropic-messages', { tools: true, images: [{ bytes: 1_300_000, width: 1280, height: 720 }], model: claude }),
    of('anthropic-messages', { tools: false, images: [{ bytes: 900 }], model: claude }),
    of('something-new', { tools: false, images: [{ bytes: 1_300_000, width: 1280, height: 720 }], model: claude }),
  ], [675 + 1229 - 1_300_000, 4784 - 900, 1229 - 1_300_000]);
});

test("imageInputOf reads the size an image's own header gives (PNG, GIF, WebP, JPEG) and the bytes its data takes; a URL the provider fetches takes none", () => {
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(png, 0);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(720, 20);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(8)]);
  const webpX = Buffer.alloc(30);
  webpX.write('RIFF', 0, 'latin1'); webpX.write('WEBP', 8, 'latin1'); webpX.write('VP8X', 12, 'latin1');
  webpX.writeUIntLE(1279, 24, 3); webpX.writeUIntLE(719, 27, 3);
  // A JPEG with an APP0 segment before its baseline frame header (SOF0): height 720, width 1280.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const [kind, bytes, size] of [['png', png, [1280, 720]], ['gif', gif, [320, 240]], ['webp', webpX, [1280, 720]], ['jpeg', jpeg, [1280, 720]]]) {
    const data = b64(bytes);
    assert.deepEqual(host.imageInputOf(data), { bytes: data.length, width: size[0], height: size[1] }, kind);
    const url = `data:image/${kind};base64,${data}`;
    assert.deepEqual(host.imageInputOf(url), { bytes: url.length, width: size[0], height: size[1] }, `${kind} as a data URL`);
  }
  assert.deepEqual(host.imageInputOf(b64(Buffer.from('not an image at all'))), { bytes: 28 }, 'no size it can read: its bytes, to be counted at the most an image is billed as');
  assert.deepEqual([host.imageInputOf('https://example.com/a.png'), host.imageInputOf(undefined), host.imageInputOf('data:image/png,raw')], [{ bytes: 0 }, { bytes: 0 }, { bytes: 0 }]);
});

test("every other API, pi's other kinds and a faux one included, gets the general figure: nothing for text, an assumed 2,048 tokens with tools, and the largest per-image maximum; never undefined", () => {
  const of = host.providerInputOverhead;
  assert.equal(host.ASSUMED_TOOL_PROMPT_TOKENS, 2048);
  for (const api of ['mistral-conversations', 'bedrock-converse-stream', 'google-generative-ai', 'google-vertex', 'pi-messages', 'faux:stand-in', 'something-new']) {
    assert.deepEqual([of(api, { tools: false, images: [] }), of(api, { tools: true, images: [] }), of(api, { tools: true, toolChoice: 'any', images: unsized(2) })], [0, 2048, 2048 + 2 * 73_800], api);
  }
});

test("Chat Completions, which gateways to other providers speak, counts the largest tool prompt it may be billed, a flat 804 with tools whatever the tool_choice; nothing for messages; and OpenAI's per-image maximum, above Anthropic's", () => {
  const of = host.providerInputOverhead;
  assert.deepEqual([
    of('openai-completions', { tools: false, images: [] }),
    of('openai-completions', { tools: true, images: [] }),
    of('openai-completions', { tools: true, toolChoice: 'none', images: [] }),
    of('openai-completions', { tools: true, toolChoice: 'any', images: [] }),
    of('openai-completions', { tools: true, toolChoice: 'tool', images: unsized(2) }),
    of('openai-completions', { tools: false, images: unsized(1) }),
  ], [0, 804, 804, 804, 804 + 2 * 73_800, 73_800]);
  assert.ok(of('openai-completions', { tools: true, images: unsized(1) }) >= of('anthropic-messages', { tools: true, images: unsized(1) }), 'never under what Anthropic bills for the same request');
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

test("a request in flight carries what its host held it at, so a budget holds it at that figure beside the next one", async () => {
  const asked = [];
  const booking = await modelPortFor(await memorySessionStore().open('chat:held'), { key: 'chat:held', budgetUsd: 1, beforeRequest: (r) => { asked.push(r); return { holdUsd: 0.25 }; } });
  await booking.models.beforeRequest({ model: 'm', inputTokensMax: 10 });
  await booking.models.beforeRequest({ model: 'm', inputTokensMax: 20 });
  assert.deepEqual(asked.at(-1).inFlight, [{ turn: 1, model: 'm', inputTokensMax: 10, holdUsd: 0.25 }]);
});
