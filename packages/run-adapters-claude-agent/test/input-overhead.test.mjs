// The input the Messages API bills for a body that the body does not carry: the tool-use system prompt it adds to a
// request with tools, and each image at the most one image is billed as, whatever its bytes (the kernel's
// providerInputOverhead holds the figures and their sources). The model proxy adds it to the body's bytes for the
// request's inputTokensMax, so a small request with tools, or with a small image of large dimensions, near a budget is not
// undercounted. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import * as host from '@parcha/agentrun-adapters/host';
import { anthropicPolicy } from '@parcha/agentrun-claude-agent';
import * as claudePolicy from '../dist/host/policy.js';

const { startModelProxy } = host;
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

test("each image adds the most one image is billed as, 4,784 tokens (the high-resolution tier), at any depth, through the shared figures", () => {
  assert.equal(host.ANTHROPIC_IMAGE_TOKENS_MAX, 4784);
  assert.equal(overheadOf(withResult([image])), 675 + 4784);
  assert.equal(overheadOf(withResult([{ type: 'text', text: 'two views' }, image, image])), 675 + 2 * 4784);
  assert.equal(overheadOf(bodyWith({ messages: [{ role: 'user', content: [image] }] })), 4784, 'an image with no tools');
  assert.equal(overheadOf(withResult([image])), host.providerInputOverhead?.('anthropic-messages', { tools: true, images: 1 }), 'the policy and the shared function agree');
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
  await refusedJustUnder(t, withResult([image]), PROMPT.autoOrNone + IMAGE);
});
