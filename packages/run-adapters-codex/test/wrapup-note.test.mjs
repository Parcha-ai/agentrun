// The spend cap's wrap-up note on OpenAI's Responses API (the policy's addNote): one developer message appended to the
// input, after everything Codex sent, so the cached prefix (the earlier items) is unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexPolicy } from '../dist/host/policy.js';

const NOTE = 'About $0.07 left of this run\'s budget: finish now with your answer.';

test('the note: one trailing developer message, every earlier input item as Codex sent it', () => {
  const policy = codexPolicy({ model: 'session-model', tools: ['lookup'] });
  assert.equal(typeof policy.addNote, 'function', 'the policy places a note');
  const sent = { model: 'session-model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write the report.' }] }, { type: 'function_call_output', call_id: 'c1', output: 'found' }] };
  const noted = policy.addNote?.(structuredClone(sent), NOTE);
  assert.deepEqual(noted?.input?.slice(0, -1), sent.input, 'earlier items unchanged');
  assert.deepEqual(noted.input.at(-1), { type: 'message', role: 'developer', content: [{ type: 'input_text', text: NOTE }] });
});
