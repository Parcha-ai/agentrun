// The local count of a Responses request's input tokens (o200k_base over the body as sent, plus LOCAL_COUNT_MARGIN), and
// how the model proxy uses it: on a request its provider did not count, its input bound is the local count when that is
// below the byte bound; a provider's count, when one came, is used and the local count is never taken. No network: the
// provider is a scripted fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageInputOf, imageTokens, LOCAL_COUNT_MARGIN, messagesLocalInputTokens, o200kModel, o200kTokens, responsesLocalInputTokens, startModelProxy } from '@parcha/agentrun-kernel/host';

const MODEL = 'gpt-6.1-sol';
const bytes = (value) => Buffer.byteLength(value, 'utf8');
/** A Responses body asking `model` with one user message of `text`. */
const message = (text, model = MODEL) => ({ model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] });
/** Ten words of o200k_base that are one token each with their space. */
const WORDS = [' the', ' and', ' for', ' was', ' are', ' you', ' not', ' but', ' can', ' all'];
const words = (n) => Array.from({ length: n }, (_, i) => WORDS[(i * 7) % WORDS.length]).join('');
/** The margin's figure for `tokens` counted over a body of `items` items. */
const withMargin = (tokens, items) => Math.ceil(tokens * (1 + LOCAL_COUNT_MARGIN.share)) + LOCAL_COUNT_MARGIN.perItem * items + LOCAL_COUNT_MARGIN.perRequest;

test("the margin is stated: a tenth more than the count, 16 tokens an item, 256 a request", () => {
  assert.deepEqual({ ...LOCAL_COUNT_MARGIN }, { share: 0.1, perItem: 16, perRequest: 256 });
});

test("o200k_base counts known strings as OpenAI's tokenizer does, a special token's spelling as plain text", async () => {
  assert.equal(await o200kTokens('hello world'), 2);
  assert.equal(await o200kTokens(' the and for was'), 4);
  assert.equal(await o200kTokens(words(1_000)), 1_000, 'each of the ten words is one token');
  assert.equal(await o200kTokens('<|endoftext|>'), 7, 'text, never the special token, and never a throw');
});

test("a known body's local count is its JSON's tokens with the margin: 37 tokens and one item make 313", async () => {
  const body = message('hello world');
  assert.equal(await o200kTokens(JSON.stringify(body)), 37);
  // ceil(37 x 1.1) = 41, one input item at 16, and 256 for the request.
  assert.equal(await responsesLocalInputTokens(body), 41 + 16 + 256);
  assert.equal(await responsesLocalInputTokens(body), withMargin(37, 1));
});

test("a long English prompt counts near a quarter of its bytes, and never under its own tokens", async () => {
  const body = { ...message(words(32_100)), tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] };
  const local = await responsesLocalInputTokens(body);
  assert.equal(local, withMargin(await o200kTokens(JSON.stringify(body)), 2));
  assert.ok(local >= 32_100 * 1.1, `${local}: the prompt's tokens and their tenth`);
  assert.ok(local * 3 < bytes(JSON.stringify(body)), `${local} of ${bytes(JSON.stringify(body))} bytes`);
});

test("encrypted reasoning counts at its bytes and an image at what it is billed as, never as their text", async () => {
  const encrypted = 'gAAAAABo'.repeat(400);
  const reasoning = { model: MODEL, input: [...message('Go on.').input, { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: encrypted }] };
  const blank = { ...reasoning, input: [reasoning.input[0], { ...reasoning.input[1], encrypted_content: '' }] };
  assert.equal(await responsesLocalInputTokens(reasoning), withMargin(await o200kTokens(JSON.stringify(blank)), 2) + bytes(encrypted));
  // A 640 x 480 PNG's header, as a data URL: billed by its size on the routed model, never by its base64's tokens.
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  const url = `data:image/png;base64,${png.toString('base64')}`;
  const image = { model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is this?' }, { type: 'input_image', image_url: url, detail: 'high' }] }] };
  const blanked = { model: MODEL, input: [{ ...image.input[0], content: [image.input[0].content[0], { type: 'input_image', image_url: '', detail: 'high' }] }] };
  const billed = imageTokens(MODEL, { ...imageInputOf(url), detail: 'high' });
  assert.ok(billed > 0);
  assert.equal(await responsesLocalInputTokens(image), withMargin(await o200kTokens(JSON.stringify(blanked)), 1) + billed);
});

test("an image by file id or with no URL counts at the most an image of unknown size is billed as, as the byte bound counts it", async () => {
  // No bytes and no size in the body: the provider bills the stored image, so it counts at the largest per-image figure
  // (imageTokens with no size), never as the few tokens of its JSON.
  const most = imageTokens(MODEL, { bytes: 0 });
  assert.ok(most >= 1_000, `the unknown-size figure: ${most}`);
  for (const part of [{ type: 'input_image', file_id: 'file-abc123', detail: 'high' }, { type: 'input_image', file_id: 'file-abc123' }, { type: 'input_image' }]) {
    const body = { model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is this?' }, part] }] };
    const counted = await responsesLocalInputTokens(body);
    assert.equal(counted, withMargin(await o200kTokens(JSON.stringify(body)), 1) + imageTokens(MODEL, { bytes: 0, ...(part.detail ? { detail: part.detail } : {}) }), `the image counted once at its billed most: ${JSON.stringify(part)}`);
    assert.ok(counted > most, `never under the image alone: ${counted}`);
  }
  // As an input item of its own and in a function call's output, the same.
  const item = { model: MODEL, input: [{ type: 'input_image', file_id: 'file-abc123' }] };
  assert.ok((await responsesLocalInputTokens(item)) > most);
  const output = { model: MODEL, input: [{ type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', file_id: 'file-abc123' }] }] };
  assert.ok((await responsesLocalInputTokens(output)) > most);
});

test("only a model on o200k_base is counted; any other, and a body with a file input, keeps its byte bound", async () => {
  for (const model of [MODEL, 'openai/gpt-6.1-sol', 'gpt-5.5', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o4-mini', 'codex-mini-latest', 'gpt-oss-120b', 'chatgpt-4o-latest']) {
    assert.ok(o200kModel(model), model);
    assert.equal(typeof await responsesLocalInputTokens(message('hello world', model)), 'number', model);
  }
  for (const model of ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo', 'claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'google/gemini-3-pro', 'openrouter/auto', 'faux', null]) {
    assert.ok(!o200kModel(model), String(model));
    assert.equal(await responsesLocalInputTokens(message('hello world', model)), undefined, String(model));
  }
  const { model: _, ...unnamed } = message('hello world');
  assert.equal(await responsesLocalInputTokens(unnamed), undefined, 'a body that names no model');
  const file = { model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=' }] }] };
  assert.equal(await responsesLocalInputTokens(file), undefined);
});

const KEY = 'session-key-for-tests';
/** A Responses-shaped policy for the proxy: the body as sent, its bound its bytes, counted locally; `extra` adds or
 *  replaces hooks (a provider's counter). */
const policyOf = (extra = {}) => ({
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/responses' }],
  keyOf: (headers) => { const auth = String(headers.authorization ?? ''); return auth.startsWith('Bearer ') ? auth.slice(7) : ''; },
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  usageOf: () => ({ input: 1, output: 1, cacheRead: 0 }),
  countInputLocally: responsesLocalInputTokens,
  ...extra,
});

/** One request of `body` through a proxy on `origin` under `policy`: what the cap was asked to hold, what was logged, and
 *  the provider's counts asked. */
async function heldThrough(t, policy, body, origin = 'https://gateway.example/openai', count) {
  const asked = [];
  const said = [];
  const counts = [];
  const p = await startModelProxy({
    policy, model: MODEL, origin, credential: () => 'provider-secret', log: (message, detail) => said.push(`${message} ${JSON.stringify(detail ?? {})}`),
    hooks: { beforeRequest: async (r) => { asked.push(r); }, afterRequest: async () => {} },
    fetch: async (url, init) => {
      if (String(url).endsWith('/count')) { counts.push(String(url)); return count(init); }
      return new Response('data: {"done":true}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  }, KEY);
  t.after(() => p.close());
  const answer = await fetch(new URL('/v1/responses', p.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
  await answer.text();
  assert.equal(asked.length, 1, said.join('\n'));
  return { held: asked[0].inputTokensMax, said, counts };
}

const PROMPT = message(words(8_000));

test("through a gateway, where the provider counts nothing, the cap holds the local count in place of the bytes", async (t) => {
  const { held } = await heldThrough(t, policyOf(), PROMPT);
  assert.equal(held, await responsesLocalInputTokens(PROMPT));
  assert.ok(held * 3 < bytes(JSON.stringify(PROMPT)), `${held} of ${bytes(JSON.stringify(PROMPT))} bytes`);
});

test("a local count above the bytes, a model it does not count, or a count that throws leaves the byte bound", async (t) => {
  const tiny = message('hi');
  assert.ok(await responsesLocalInputTokens(tiny) > bytes(JSON.stringify(tiny)), 'the request margin is more than a tiny body');
  assert.equal((await heldThrough(t, policyOf(), tiny)).held, bytes(JSON.stringify(tiny)));
  const claude = message(words(8_000), 'claude-sonnet-5.5');
  assert.equal((await heldThrough(t, policyOf(), claude)).held, bytes(JSON.stringify(claude)));
  const throws = await heldThrough(t, policyOf({ countInputLocally: async () => { throw new Error('no ranks'); } }), PROMPT);
  assert.equal(throws.held, bytes(JSON.stringify(PROMPT)));
  assert.match(throws.said.join('\n'), /the local token count failed; the request keeps its byte bound/);
  const notCount = await heldThrough(t, policyOf({ countInputLocally: () => 1.5 }), PROMPT);
  assert.equal(notCount.held, bytes(JSON.stringify(PROMPT)));
});

test("the provider's count is preferred where it comes: the local count is never taken, even when lower; a count that fails falls to the local count", async (t) => {
  const origin = 'https://provider.example';
  const local = await responsesLocalInputTokens(PROMPT);
  let localAsked = 0;
  const counted = () => policyOf({
    countInput: { origin, path: '/count', body: (body) => body, headers: () => ({}), tokensOf: (answer) => answer.tokens },
    countInputLocally: (body) => { localAsked += 1; return responsesLocalInputTokens(body); },
  });
  // The provider says more than the local count (and less than the bytes): its count stands.
  const above = await heldThrough(t, counted(), PROMPT, origin, async () => Response.json({ tokens: local + 500 }));
  assert.deepEqual([above.held, above.counts.length, localAsked], [local + 500, 1, 0]);
  // The provider's count fails: the local count.
  const failed = await heldThrough(t, counted(), PROMPT, origin, async () => new Response('no', { status: 500 }));
  assert.deepEqual([failed.held, failed.counts.length, localAsked], [local, 1, 1]);
  // Through a gateway the provider is never asked: the local count.
  const gateway = await heldThrough(t, counted(), PROMPT, 'https://gateway.example/openai', async () => { throw new Error('never asked'); });
  assert.deepEqual([gateway.held, gateway.counts.length, localAsked], [local, 0, 2]);
});

// A Messages body to a model on o200k_base (pi on gpt-6.1-sol through OpenRouter, by serve's translation): the same rule.
const SOL = 'openai/gpt-6.1-sol';
/** A Messages body asking `model` with one system block and one user message of `text`. */
const messages = (text, model = SOL) => ({ model, max_tokens: 32_000, system: [{ type: 'text', text: 'Follow the script.' }], messages: [{ role: 'user', content: text }] });

test("a Messages body's local count is its JSON's tokens with the margin: 47 tokens, a message and a system block make 340", async () => {
  const body = messages('hello world');
  assert.equal(await o200kTokens(JSON.stringify(body)), 47);
  // ceil(47 x 1.1) = 52, two items at 16 (the message, the system block), and 256 for the request.
  assert.equal(await messagesLocalInputTokens(body), 52 + 32 + 256);
  // Each block of a message is an item (a call and its result are framed apart), a message of none is one, each tool one.
  const turns = {
    ...messages('Read the page.'),
    tools: [{ name: 'read', description: 'Read a file.', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'Read the page.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: words(500) }] },
    ],
  };
  assert.equal(await messagesLocalInputTokens(turns), withMargin(await o200kTokens(JSON.stringify(turns)), 1 + 2 + 1 + 1 + 1));
});

test("a long page in a Messages body counts near a quarter of its bytes, and never under its own tokens", async () => {
  const body = { ...messages('Summarize it.'), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: words(70_000) }] }] }] };
  const local = await messagesLocalInputTokens(body);
  assert.ok(local >= 70_000 * 1.1, `${local}: the page's tokens and their tenth`);
  // Past 272,000 bytes (Sol's long-context tier, on a byte bound) at some 77,000 tokens.
  assert.ok(bytes(JSON.stringify(body)) > 272_000 && local * 3 < bytes(JSON.stringify(body)), `${local} of ${bytes(JSON.stringify(body))} bytes`);
});

test("a thinking signature counts at its bytes and an image at what the routed model bills it as, never as their text", async () => {
  const signature = 'EqQBCkYIBxgCKkA'.repeat(200);
  const thought = { ...messages('Go on.'), messages: [{ role: 'user', content: 'Go on.' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan.', signature }, { type: 'text', text: 'Done.' }] }, { role: 'user', content: 'More.' }] };
  const blank = { ...thought, messages: [thought.messages[0], { ...thought.messages[1], content: [{ ...thought.messages[1].content[0], signature: '' }, thought.messages[1].content[1]] }, thought.messages[2]] };
  assert.equal(await messagesLocalInputTokens(thought), withMargin(await o200kTokens(JSON.stringify(blank)), 1 + 2 + 1 + 1) + bytes(signature));
  const redacted = { ...messages('Go on.'), messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: signature }] }] };
  const redactedBlank = { ...redacted, messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: '' }] }] };
  assert.equal(await messagesLocalInputTokens(redacted), withMargin(await o200kTokens(JSON.stringify(redactedBlank)), 1 + 1) + bytes(signature));
  // A 640 x 480 PNG's header, in a tool's result: billed by its size on Sol, never by its base64's tokens.
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  const data = png.toString('base64');
  const shot = (source) => ({ ...messages('What is this?'), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source }] }] }] });
  const billed = imageTokens(SOL, imageInputOf(data));
  assert.ok(billed > 0);
  assert.equal(await messagesLocalInputTokens(shot({ type: 'base64', media_type: 'image/png', data })), withMargin(await o200kTokens(JSON.stringify(shot({ type: 'base64', media_type: 'image/png', data: '' }))), 1 + 1) + billed);
  // An image by URL: at the most an image of unknown size is billed as.
  const url = shot({ type: 'url', url: 'https://example.com/a.png' });
  assert.equal(await messagesLocalInputTokens(url), withMargin(await o200kTokens(JSON.stringify(url)), 1 + 1) + imageTokens(SOL, { bytes: 0 }));
});

test("a Messages body to a model not on o200k_base, one with a document, or one that is not an object keeps its byte bound", async () => {
  for (const model of ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5', 'claude-opus-5-5', 'google/gemini-3-pro', null]) assert.equal(await messagesLocalInputTokens(messages('hello world', model)), undefined, String(model));
  for (const model of [SOL, 'gpt-6.1-terra', 'openai/gpt-6-luna']) assert.equal(typeof await messagesLocalInputTokens(messages('hello world', model)), 'number', model);
  const document = { ...messages('Read it.'), messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }] }] };
  assert.equal(await messagesLocalInputTokens(document), undefined);
  const inResult = { ...messages('Read it.'), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }] }] }] };
  assert.equal(await messagesLocalInputTokens(inResult), undefined);
  assert.equal(await messagesLocalInputTokens(null), undefined);
});
