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
