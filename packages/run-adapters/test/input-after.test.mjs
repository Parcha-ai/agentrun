// A Messages request that carries an earlier request of its session that the provider billed is bounded by that bill and
// the bytes it adds (messagesInputAfter): the two must read alike in everything that bills input but the messages the later
// one adds (a cache marker, and a string content against its one text block, read alike). The model proxy keeps, by
// model, the last request of the client's own whose answer reported its whole input, and holds a request its provider did
// not count at that figure when it is below its other bounds, before the wrap-up note is asked for. No network: the
// provider is a scripted fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageInputOf, imageTokens, messagesInputAfter, startModelProxy } from '@parcha/agentrun-kernel/host';

const KEY = 'session-key-for-tests';
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const tools = [{ name: 'lookup', description: 'Look a thing up.', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }];
const system = [{ type: 'text', text: 'You answer from what you look up. '.repeat(40), cache_control: { type: 'ephemeral' } }];
const ask = { role: 'user', content: 'What is the capital of France?' };
const env = { role: 'system', content: [{ type: 'text', text: 'Today is a Monday.', cache_control: { type: 'ephemeral' } }] };
const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'capital of France' } }] };
const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Paris.' }] };
const first = { model: 'claude-main', max_tokens: 4_096, stream: true, system, tools, thinking: { type: 'adaptive' }, messages: [ask, env] };
const second = { ...first, messages: [ask, { role: 'system', content: 'Today is a Monday.' }, call, result] };
const earlier = { body: first, inputTokens: 900 };

test("a later request is its earlier one's billed input and the bytes of the messages it adds: a moved cache marker and a block given as a string read alike", () => {
  assert.equal(messagesInputAfter(earlier, second), 900 + bytes([call, result]));
  // The cache marker moves to the newest message, as a client's does: the rest reads alike.
  const moved = { ...second, system: [{ type: 'text', text: system[0].text }], messages: [{ ...ask }, { role: 'system', content: [{ type: 'text', text: 'Today is a Monday.' }] }, call, { ...result, content: [{ ...result.content[0], cache_control: { type: 'ephemeral' } }] }] };
  assert.equal(messagesInputAfter(earlier, moved), 900 + bytes(moved.messages.slice(2)));
  // What bills no input may differ: the output asked, streaming, who asks.
  assert.equal(messagesInputAfter(earlier, { ...second, max_tokens: 1_024, stream: false, metadata: { user_id: 'u' } }), 900 + bytes([call, result]));
  // A message of the earlier request the later one drops was billed and is not carried: the figure only overcounts.
  assert.equal(messagesInputAfter(earlier, { ...second, messages: [ask, call, result] }), 900 + bytes([call, result]));
});

test("a later request that differs in what bills input (its tools, its system prompt, its thinking, its effort), an earlier figure that is no count, or added messages holding a document says nothing", () => {
  for (const [name, changed] of Object.entries({
    tools: { ...second, tools: [] },
    system: { ...second, system: [{ type: 'text', text: 'Another prompt.' }] },
    thinking: { ...second, thinking: { type: 'enabled', budget_tokens: 2_048 } },
    effort: { ...second, output_config: { effort: 'high' } },
    model: { ...second, model: 'claude-other' },
  })) assert.equal(messagesInputAfter(earlier, changed), undefined, name);
  for (const inputTokens of [0, -1, 1.5, Number.NaN, undefined]) assert.equal(messagesInputAfter({ body: first, inputTokens }, second), undefined, String(inputTokens));
  assert.equal(messagesInputAfter({ inputTokens: 900 }, second), undefined);
  const document = { ...second, messages: [...second.messages.slice(0, 3), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }] }] }] };
  assert.equal(messagesInputAfter(earlier, document), undefined);
});

test("a `cache_control` key the API does not read as a cache marker bills as any other text: a tool's schema property of that name that grows says nothing, and a tool call's input key of that name that grows counts from its message on", () => {
  const named = (description) => [{ ...tools[0], input_schema: { type: 'object', properties: { ...tools[0].input_schema.properties, cache_control: { type: 'string', description } } } }];
  const grown = 'Whether to cache the answer, and for how long, in every case this tool knows of. '.repeat(200);
  assert.equal(messagesInputAfter({ body: { ...first, tools: named('Cache it.') }, inputTokens: 900 }, { ...second, tools: named(grown) }), undefined, "the tools differ in a schema's text");
  const keyed = (text) => ({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'capital of France', cache_control: text } }] });
  const again = { role: 'user', content: 'And of Spain?' };
  const later = { ...first, messages: [ask, env, keyed(grown), result, again] };
  assert.equal(messagesInputAfter({ body: { ...first, messages: [ask, env, keyed('no'), result] }, inputTokens: 900 }, later), 900 + bytes(later.messages.slice(2)), "the tool call's input differs: it and what follows are added");
  // A tool result's text that is JSON is a string the API never parses: it was always compared as written.
  const text = (value) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ cache_control: value }) }] });
  const read = { ...first, messages: [ask, env, call, text(grown), again] };
  assert.equal(messagesInputAfter({ body: { ...first, messages: [ask, env, call, text('no')] }, inputTokens: 900 }, read), 900 + bytes(read.messages.slice(3)));
});

test("a cache marker where the API reads one (a tool, a system block, a message's content block, a block of a tool result's content) bills nothing and may move", () => {
  const marker = { cache_control: { type: 'ephemeral', ttl: '1h' } };
  const shot = (mark) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Paris.', ...mark }] }] });
  const again = { role: 'user', content: 'And of Spain?' };
  const before = { ...first, tools: [{ ...tools[0], ...marker }], messages: [ask, env, call, shot(marker)] };
  const after = { ...first, system: [{ type: 'text', text: system[0].text }], messages: [ask, { role: 'system', content: 'Today is a Monday.' }, { ...call, content: [{ ...call.content[0], ...marker }] }, shot({}), again] };
  assert.equal(messagesInputAfter({ body: before, inputTokens: 900 }, after), 900 + bytes([again]));
});

test("an image the later request adds counts at what the routed model bills it as, in place of its base64", () => {
  const png = Buffer.alloc(64);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(1_200, 16);
  png.writeUInt32BE(800, 20);
  const data = png.toString('base64');
  const shot = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] };
  const image = imageInputOf(data);
  assert.equal(messagesInputAfter(earlier, { ...second, messages: [ask, env, call, shot] }), 900 + bytes([call, shot]) - image.bytes + imageTokens('claude-main', image));
});

/** A proxy on a gateway (no provider count) under a Messages-like policy whose answers report `usage` (or none): what
 *  each request was held at, and a sender. */
async function proxied(t, { usage = { input: 4, output: 10, cacheRead: 600, cacheWrite: 296 }, note } = {}) {
  const asked = [];
  const policy = {
    id: 'messages',
    routes: [{ method: 'POST', path: '/v1/messages' }],
    keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply: (body) => body,
    modelOf: (body) => body.model,
    usageOf: () => (typeof usage === 'function' ? usage() : usage),
    inputAfter: messagesInputAfter,
    addNote: (body, text) => ({ ...body, messages: [...body.messages, { role: 'user', content: text }] }),
  };
  const hooks = { beforeRequest: async (r) => void asked.push(r), afterRequest: async () => {}, ...(note ? { note } : {}) };
  const p = await startModelProxy({ policy, model: 'claude-main', origin: 'https://gateway.example/api', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }, KEY);
  t.after(() => p.close());
  const send = async (body) => (await fetch(new URL('/v1/messages', p.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) })).text();
  return { asked, send };
}

test("through a gateway, a session's second request is held at its first one's billed input (input, cache reads and writes) and the bytes it adds, where that is below its bytes", async (t) => {
  const { asked, send } = await proxied(t);
  await send(first);
  await send(second);
  assert.equal(asked[0].inputTokensMax, bytes(first), 'the first request: its bytes, nothing billed before it');
  assert.equal(asked[1].inputTokensMax, 900 + bytes([call, result]), `its first's 900 billed and the bytes it adds, against its ${bytes(second)} bytes`);
});

test("only an answer that reported its usage, on the same model, bounds a later request: an unread usage or another model's request leaves the bytes; a figure above the bytes is not taken", async (t) => {
  const unread = await proxied(t, { usage: () => undefined });
  await unread.send(first);
  await unread.send(second);
  assert.equal(unread.asked[1].inputTokensMax, bytes(second), 'no usage read: nothing to bound it by');
  const other = await proxied(t);
  await other.send({ ...first, model: 'claude-small' });
  await other.send(second);
  assert.equal(other.asked[1].inputTokensMax, bytes(second), "the small model's billed request says nothing of the main model's");
  const dear = await proxied(t, { usage: { input: 1_000_000, output: 1, cacheRead: 0 } });
  await dear.send(first);
  await dear.send(second);
  assert.equal(dear.asked[1].inputTokensMax, bytes(second), 'a bill above the bytes: the bytes, the lower');
});

test("the wrap-up note is asked for on the billed bound, and the noted request is that bound and the note's bytes", async (t) => {
  const NOTE = 'About $0.02 left of this run\'s budget: finish now with your answer.';
  const asks = [];
  let notes = 0;
  const { asked, send } = await proxied(t, { note: (_model, request) => (asks.push(request), (notes += 1) === 2 ? NOTE : undefined) });
  await send(first);
  await send(second);
  const after = 900 + bytes([call, result]);
  assert.deepEqual(asks[1], { inputTokensMax: after }, 'the note is asked for on the billed bound, not the bytes');
  assert.equal(asked[1].inputTokensMaxWithoutNote, after);
  const withNote = { ...second, messages: [...second.messages, { role: 'user', content: NOTE }] };
  assert.equal(asked[1].inputTokensMax, after + bytes(withNote) - bytes(second), 'the billed bound and the bytes the note adds');
});
