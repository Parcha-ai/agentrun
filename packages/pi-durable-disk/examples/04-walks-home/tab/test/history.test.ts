import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatMessages, HELD, isHeld } from '../src/history.ts';
import { REFUSAL } from '../src/guard.ts';

const user = (text: string) => ({ role: 'user', content: text });
const asst = (...blocks: { type: string; text?: string; thinking?: string; name?: string }[]) => ({ role: 'assistant', content: blocks });
const say = (text: string) => asst({ type: 'text', text });
const roles = (m: { role: string }[]) => m.map((x) => x.role).join(',');

test('"none": the newest user message alone, whatever came before', () => {
  const m = chatMessages([user('a'), say('A'), user('b'), say('B'), user('c')], 'none');
  assert.deepEqual(m, [{ role: 'user', content: 'c' }]);
});

test('"last": the previous exchange and the new question, with the answer TEXT only: thinking, tool calls, tool results and system messages never reach the model', () => {
  const m = chatMessages([
    { role: 'system', content: 'You are a coding agent.' },
    user('a'), say('A'),
    user('b'),
    asst({ type: 'thinking', thinking: 'I wonder about b, and about a earlier' }, { type: 'toolCall', name: 'bash' }, { type: 'text', text: 'B is this.' }),
    { role: 'toolResult', content: [{ type: 'text', text: 'ls output' }] },
    user('c'),
  ], 'last');
  assert.deepEqual(m, [{ role: 'user', content: 'b' }, { role: 'assistant', content: 'B is this.' }, { role: 'user', content: 'c' }]);
  assert.ok(!JSON.stringify(m).includes('wonder'), 'no thinking');
});

test('the first question has no history in either mode; a conversation with no user message sends nothing', () => {
  assert.deepEqual(chatMessages([user('a')], 'last'), [{ role: 'user', content: 'a' }]);
  assert.deepEqual(chatMessages([], 'last'), []);
  assert.deepEqual(chatMessages([say('A')], 'last'), []);
});

test('an exchange whose answer was held, failed or came out empty is not carried, and the question is answered fresh (never from an older exchange)', () => {
  const held = { role: 'assistant', content: [{ type: 'text', text: REFUSAL }], rawStopReason: HELD };
  assert.deepEqual(chatMessages([user('a'), say('A'), user('b'), held, user('c')], 'last'), [{ role: 'user', content: 'c' }]);
  assert.deepEqual(chatMessages([user('a'), say('A'), user('b'), { role: 'assistant', content: [], stopReason: 'error' }, user('c')], 'last'), [{ role: 'user', content: 'c' }]);
  assert.deepEqual(chatMessages([user('a'), say('A'), user('b'), asst({ type: 'thinking', thinking: 'only a thought' }), user('c')], 'last'), [{ role: 'user', content: 'c' }]);
});

test('a held answer is recognised by its mark, or by being exactly the refusal line', () => {
  assert.equal(isHeld({ role: 'assistant', content: [{ type: 'text', text: 'x' }], rawStopReason: HELD }), true);
  assert.equal(isHeld(say(REFUSAL)), true);
  assert.equal(isHeld(say('I can answer that.')), false);
  assert.equal(isHeld(user(REFUSAL)), false);
});

test('user content may be text blocks; only the text is used', () => {
  const m = chatMessages([{ role: 'user', content: [{ type: 'text', text: 'hel' }, { type: 'image' }, { type: 'text', text: 'lo' }] }], 'last');
  assert.deepEqual(m, [{ role: 'user', content: 'hello' }]);
  assert.equal(roles(m), 'user');
});
