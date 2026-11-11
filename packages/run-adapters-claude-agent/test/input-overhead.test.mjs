// The input the Messages API bills for a body that the body does not carry: the tool-use system prompt it adds to a
// request with tools, and each image at the most it can be billed as by its size, in place of its base64's bytes (the
// kernel's providerInputOverhead holds the figures and their sources). The model proxy adds it to the body's bytes for the
// request's inputTokensMax, so a small request with tools, or with a small image of large dimensions, near a budget is not
// undercounted, and a screenshot's megabyte of base64 is never read as a megabyte of tokens. No network: the provider is a
// scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import * as host from '@parcha/agentrun-kernel/host';
import { anthropicPolicy } from '@parcha/agentrun-harness-claude';
import * as claudePolicy from '../dist/host/policy.js';

const { startModelProxy } = host;
const { inputTokensMaxOf } = await import('@parcha/agentrun-kernel/testing');
const { beforeRequestOf } = await import('@parcha/agentrun-kernel/kernel/cap');
const { applyAnthropic } = claudePolicy;
// Read from the module, so that on a build without them each test fails by name rather than the file failing to load.
const PROMPT = host.ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS ?? { autoOrNone: 675, anyOrTool: 804 };
const IMAGE = host.ANTHROPIC_IMAGE_TOKENS_MAX ?? 4784;
const overheadOf = (body) => claudePolicy.anthropicServerInputOverhead?.(body);

const options = { model: 'claude-main', smallModel: 'claude-small', tools: ['lookup'], maxOutputTokens: 8_000 };
const policy = anthropicPolicy(options);
const MESSAGES = policy.routes.find((r) => r.path === '/v1/messages');
const tool = { name: 'mcp__hands__lookup', description: 'Look a fact up.', input_schema: { type: 'object', properties: { q: { type: 'string' } } } };
const bodyWith = (extra) => ({ model: 'claude-main', max_tokens: 1024, messages: [{ role: 'user', content: 'Look up the capital of France.' }], ...extra });

/** A valid PNG of `width` x `height` one-bit pixels, all black: large dimensions in a few hundred bytes. */
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(8 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([1, 0, 0, 0, 0], 8); // bit depth 1, greyscale, deflate, no filter, no interlace
  const raw = Buffer.alloc((1 + Math.ceil(width / 8)) * height); // each row: filter 0, then zero bits
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const BIG_SMALL_PNG = png(2000, 2000).toString('base64');
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_SMALL_PNG } };
/** A body whose last turn is a tool's result holding `content`. */
const withResult = (content, extra = {}) => bodyWith({ tools: [tool], ...extra, messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: tool.name, input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] }] });

test("the tool-use system prompt is the documented largest for any current model: 675 tokens for auto or none, 804 for any or tool, none without tools", () => {
  assert.deepEqual(host.ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS, { autoOrNone: 675, anyOrTool: 804 });
  assert.deepEqual([
    overheadOf(bodyWith({})),
    overheadOf(bodyWith({ tools: [] })),
    overheadOf(bodyWith({ tools: [tool] })),
    overheadOf(bodyWith({ tools: [tool], tool_choice: { type: 'auto' } })),
    overheadOf(bodyWith({ tools: [tool], tool_choice: { type: 'none' } })),
    overheadOf(bodyWith({ tools: [tool], tool_choice: { type: 'any' } })),
    overheadOf(bodyWith({ tools: [tool], tool_choice: { type: 'tool', name: tool.name } })),
  ], [0, 0, 675, 675, 675, 804, 804]);
  assert.equal(policy.serverInputOverhead, claudePolicy.anthropicServerInputOverhead, 'the policy says it');
});

test("each image counts at the most it can be billed as by its size (a 2000x2000 one at the high-resolution tier's 4,784 tokens), at any depth, in place of its base64's bytes, through the shared figures", () => {
  const B = BIG_SMALL_PNG.length;
  assert.equal(host.ANTHROPIC_IMAGE_TOKENS_MAX, 4784);
  assert.equal(overheadOf(withResult([image])), 675 + 4784 - B);
  assert.equal(overheadOf(withResult([{ type: 'text', text: 'two views' }, image, image])), 675 + 2 * (4784 - B));
  assert.equal(overheadOf(bodyWith({ messages: [{ role: 'user', content: [image] }] })), 4784 - B, 'an image with no tools');
  assert.equal(overheadOf(withResult([image])), host.providerInputOverhead?.('anthropic-messages', { tools: true, images: [{ bytes: B, width: 2000, height: 2000 }], model: 'claude-main' }), 'the policy and the shared function agree');
  assert.equal(overheadOf(bodyWith({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }] })), 4784, 'an image the provider fetches: its most, its URL\'s bytes kept');
  assert.ok(Buffer.byteLength(BIG_SMALL_PNG) < 1000, `the test image is ${Buffer.byteLength(BIG_SMALL_PNG)} bytes of base64 for 2000x2000 px`);
});

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

/** A proxy under the Claude policy whose host refuses a request whose input bound is over `room` tokens. */
async function capped(t, room) {
  const sent = [];
  const asked = [];
  const p = await startModelProxy({
    policy, model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r.inputTokensMax); if (r.inputTokensMax === undefined || r.inputTokensMax > room) throw new Error('over what is left'); }, afterRequest: async () => {} },
    fetch: async (_url, init) => { sent.push(init.body); return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
  }, 'session-key');
  t.after(() => p.close());
  return { p, sent, asked };
}

/** The request is refused before it is sent with one token less room than `bound` above its bytes, and sent with exactly that. */
async function refusedJustUnder(t, body, bound) {
  const bytes = Buffer.byteLength(JSON.stringify(applyAnthropic(body, MESSAGES, options)), 'utf8');
  const tight = await capped(t, bytes + bound - 1);
  const refused = await send(tight.p.url, body);
  assert.notEqual(refused.status, 200, refused.text);
  assert.deepEqual([tight.sent.length, tight.asked], [0, [bytes + bound]], 'refused before it was sent, on its whole bound');
  const enough = await capped(t, bytes + bound);
  const passed = await send(enough.p.url, body);
  assert.equal(passed.status, 200, passed.text);
  assert.equal(enough.sent.length, 1);
  assert.equal(Buffer.byteLength(enough.sent[0], 'utf8'), bytes, 'the body measured is the body sent');
}

test("a small request with tools whose body fits what is left, but not with the tool-use system prompt, is refused before it is sent", async (t) => {
  await refusedJustUnder(t, bodyWith({ tools: [tool] }), PROMPT.autoOrNone);
});

test("a request whose body fits what is left, but not with its image's allowance (a small PNG of 2000x2000 px), is refused before it is sent", async (t) => {
  await refusedJustUnder(t, withResult([image]), PROMPT.autoOrNone + IMAGE - BIG_SMALL_PNG.length);
});

/** A 1280x720 RGB PNG the size a desktop's screenshot is: its top `noisy` rows hold pixels that do not compress (a fixed
 *  pseudo-random stream), the rest are black, so its base64 is about a megabyte, as a real screen's is. */
function screenshot(width, height, noisy = 260) {
  const row = 1 + 3 * width;
  const raw = Buffer.alloc(row * height);
  let x = 0x9e3779b9;
  for (let at = 0; at < noisy * row; at += 1) {
    if (at % row === 0) continue; // the row's filter byte: none
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    raw[at] = x & 0xff;
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(8 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // bit depth 8, RGB, deflate, no filter, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const SCREEN = screenshot(1280, 720);
const screenShot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SCREEN } };
/** What Claude bills a 1280x720 image as: its area at 750 pixels a token (the standard tier's rule), above its count of
 *  28 px patches (46 x 26 = 1,196, the high-resolution tier's). */
const SCREEN_TOKENS = Math.ceil((1280 * 720) / 750);
/** A desktop run's request after `shots` screenshots: each a tool's result, as pi's desktop_screen returns it. */
function desktopBody(shots) {
  const messages = [{ role: 'user', content: 'Open a terminal, run hostname, and write what it prints to answer.md.' }];
  for (let i = 0; i < shots; i += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: tool.name, input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'A screenshot of the whole screen, 1280x720 pixels.' }, screenShot] }] });
  }
  return applyAnthropic(bodyWith({ tools: [tool], messages }), MESSAGES, options);
}

test("a 1280x720 screenshot is counted at the area Claude bills it by (within 3x, never under), never as its megabyte of base64", () => {
  assert.ok(SCREEN.length > 900_000, `the screenshot is ${SCREEN.length} bytes of base64, as a real screen's`);
  const body = desktopBody(1);
  const sent = JSON.stringify(body);
  const bound = inputTokensMaxOf(policy, body, sent);
  // The body's bytes besides the image's data are a bound on its text; the tool-use prompt is Claude's own.
  const rest = Buffer.byteLength(sent, 'utf8') - SCREEN.length;
  const image = bound - rest - PROMPT.autoOrNone;
  assert.ok(image >= SCREEN_TOKENS, `never under what Claude bills it: ${image} tokens for the image, billed ${SCREEN_TOKENS}`);
  assert.ok(image <= 3 * SCREEN_TOKENS, `within 3x of what Claude bills it: ${image} tokens for the image (${bound} in all), billed ${SCREEN_TOKENS}`);
});

test("every screenshot in the history counts the same way: a request carrying five earlier screens is bounded within 3x of what Claude bills for them, never under", () => {
  const body = desktopBody(5);
  const sent = JSON.stringify(body);
  const bound = inputTokensMaxOf(policy, body, sent);
  const rest = Buffer.byteLength(sent, 'utf8') - 5 * SCREEN.length;
  const images = bound - rest - PROMPT.autoOrNone;
  assert.ok(images >= 5 * SCREEN_TOKENS && images <= 3 * 5 * SCREEN_TOKENS, `five screens: ${images} tokens, billed ${5 * SCREEN_TOKENS}`);
});

test("through a gateway, a screenshot counts at the routed model's provider's rule, never its bytes: an OpenAI or Gemini model on the Messages API, and one of no known provider at the most of the rules", () => {
  const counted = (model) => {
    const body = { ...desktopBody(1), model };
    const sent = JSON.stringify(body);
    return inputTokensMaxOf(policy, body, sent) - (Buffer.byteLength(sent, 'utf8') - SCREEN.length) - PROMPT.autoOrNone;
  };
  assert.deepEqual(['anthropic/claude-sonnet-5.5', 'openai/gpt-5', 'google/gemini-3-pro', 'meta-llama/llama-4'].map(counted), [1229, 2264, 1120, 2264]);
});

test("an image-shaped object in a tool call's arguments is text to the provider: its bytes stay counted, never swapped for an image's allowance", () => {
  const big = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SCREEN } };
  const body = applyAnthropic(bodyWith({ tools: [tool], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: tool.name, input: { q: 'look', attachment: big } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] }] }), MESSAGES, options);
  assert.equal(overheadOf(body), PROMPT.autoOrNone, 'no image read from the arguments: its tool prompt alone');
  const sent = JSON.stringify(body);
  assert.equal(inputTokensMaxOf(policy, body, sent), Buffer.byteLength(sent, 'utf8') + PROMPT.autoOrNone, 'every byte of the arguments counted');
});

test("a desktop run on Sonnet under a $1.50 cap takes step after step of screenshots: each step's least is cents, never the dollars its base64 would read as", () => {
  const sonnet = { id: 'claude-main', api: 'anthropic-messages', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 };
  const before = beforeRequestOf({ capUsd: () => 1.5, modelOf: (id) => (id === sonnet.id ? sonnet : undefined) });
  let spent = 0;
  for (let shots = 1; shots <= 6; shots += 1) {
    const body = desktopBody(shots);
    const inputTokensMax = inputTokensMaxOf(policy, body, JSON.stringify(body));
    const verdict = before({ model: sonnet.id, turn: shots + 1, spentUsd: spent, inFlight: [], inputTokensMax, outputTokensAsked: body.max_tokens, outputTokensLeast: policy.outputLeast(body) });
    assert.ok(!(verdict && 'refuse' in verdict), `step ${shots + 1} (${shots} screenshot(s), input bound ${inputTokensMax}) is sent under $1.50 after $${spent.toFixed(4)}: ${verdict?.refuse}`);
    // What such a step bills: its screenshots and a little text, written to the cache, and a short answer.
    spent += ((shots * SCREEN_TOKENS + 3_000) * 3.75 + 100 * 15) / 1e6;
  }
});
