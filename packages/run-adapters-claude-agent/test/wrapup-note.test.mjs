// The spend cap's wrap-up note on Anthropic's Messages API (the policy's addNote): one text block appended to the last
// user message, after everything the Claude CLI sent, with no cache marker of its own, so every cache_control stays on the
// block it was on and the cached prefix ends where it did.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicPolicy } from '../dist/host/policy.js';

const policy = anthropicPolicy({ model: 'claude-main', smallModel: 'claude-small', tools: ['lookup'] });
const NOTE = 'About $0.07 left of this run\'s budget: finish now with your answer.';
const body = () => ({
  model: 'claude-main',
  system: [{ type: 'text', text: 'You are the agent.', cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Write the report.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__hands__lookup', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'found' }, { type: 'text', text: 'go on', cache_control: { type: 'ephemeral' } }] },
  ],
});

test('the note: one text block at the end of the last user message, every earlier block and cache marker as the CLI sent it', () => {
  assert.equal(typeof policy.addNote, 'function', 'the policy places a note');
  const sent = body();
  const noted = policy.addNote?.(structuredClone(sent), NOTE);
  const last = noted?.messages?.at(-1);
  assert.equal(last?.content?.length, sent.messages.at(-1).content.length + 1, 'one block more');
  assert.deepEqual(last.content.slice(0, -1), sent.messages.at(-1).content, 'its earlier blocks, cache marker included, unchanged');
  assert.deepEqual(last.content.at(-1), { type: 'text', text: `<system-reminder>${NOTE}</system-reminder>` }, 'the note, with no cache marker');
  assert.deepEqual(noted.messages.slice(0, -1), sent.messages.slice(0, -1), 'earlier messages unchanged');
  assert.deepEqual(noted.system, sent.system, 'the system prompt unchanged');
});

test('a request that ends with the CLI\'s system message (its environment note at a turn\'s start) keeps it last, untouched: the note is the last block of the user message before it, as the API takes a system message only before an assistant message or at the end', () => {
  const env = { role: 'system', content: [{ type: 'text', text: 'The current date is 2026-11-07.' }] };
  const reminder = { type: 'text', text: `<system-reminder>${NOTE}</system-reminder>` };
  // A turn's first request: [user, system] -> [user + note, system] (a user message after the system one is refused, 400).
  const start = { model: 'claude-main', messages: [{ role: 'user', content: 'Write the report.' }, env] };
  assert.deepEqual(policy.addNote?.(structuredClone(start), NOTE).messages, [{ role: 'user', content: [{ type: 'text', text: 'Write the report.' }, reminder] }, env]);
  // Tool results then the system message: the note after the results, in the same user message.
  const results = { model: 'claude-main', messages: [...body().messages, env] };
  const noted = policy.addNote?.(structuredClone(results), NOTE).messages;
  assert.deepEqual(noted.at(-1), env, 'the system message stays last, as sent');
  assert.deepEqual(noted.at(-2).content, [...body().messages.at(-1).content, reminder], 'the note is the last block of the last user message');
  assert.deepEqual(noted.slice(0, -2), body().messages.slice(0, -1), 'earlier messages unchanged');
  // After an answer: a user message of its own, still before the system message.
  const answered = { model: 'claude-main', messages: [{ role: 'user', content: 'Hi.' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }, env] };
  assert.deepEqual(policy.addNote?.(structuredClone(answered), NOTE).messages, [answered.messages[0], answered.messages[1], { role: 'user', content: [reminder] }, env]);
});

test('through the proxy, a turn\'s first request ([user, system]) is admitted at its bound with the note in it: the note\'s bytes over the bound of the body as the CLI sent it', async (t) => {
  const { startModelProxy } = await import('@parcha/agentrun-kernel/host');
  const asked = [];
  const forwarded = [];
  const notes = [NOTE];
  const hooks = { beforeRequest: async (request) => void asked.push(request), afterRequest: async () => {}, note: () => notes.shift() };
  const fetchUp = async (_url, init) => (forwarded.push(JSON.parse(init.body)), new Response('{}', { headers: { 'content-type': 'application/json' } }));
  const proxy = await startModelProxy({ policy, model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, log: () => {}, fetch: fetchUp }, 'session-key');
  t.after(() => proxy.close());
  const start = { model: 'claude-main', max_tokens: 32_000, messages: [{ role: 'user', content: 'Write the report.' }, { role: 'system', content: [{ type: 'text', text: 'The current date is 2026-11-07.' }] }] };
  const res = await fetch(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(start) });
  await res.text();
  assert.equal(res.status, 200);
  assert.deepEqual(forwarded[0].messages.map((m) => m.role), ['user', 'system'], 'sent with the system message last');
  const [request] = asked;
  assert.equal(request.noted, true, 'admitted as carrying the note');
  assert.ok(request.inputTokensMax - request.inputTokensMaxWithoutNote >= Buffer.byteLength(`<system-reminder>${NOTE}</system-reminder>`, 'utf8'), `its bound counts the note's bytes: ${request.inputTokensMax} vs ${request.inputTokensMaxWithoutNote} without it`);
});
