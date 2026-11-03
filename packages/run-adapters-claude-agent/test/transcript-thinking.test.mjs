// The model's thinking, as the transcript hears it from the SDK: each thinking block's summary is a live event, so the
// host can show it as pi shows its own. A block with no text (the "omitted" display, or a redacted block) shows nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TranscriptBuilder } from '../dist/transcript.js';

const heard = () => {
  const live = [];
  const entries = [];
  return { live, entries, builder: new TranscriptBuilder({ message: (e) => entries.push(e), live: (e) => live.push(e) }) };
};

test("a thinking block's summary is a live thinking event, in order; an empty or redacted one is not, and none is written as text", () => {
  const { live, entries, builder } = heard();
  builder.observe({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Plan the search first.', signature: 'sig_1' }] } });
  builder.observe({ type: 'assistant', message: { content: [{ type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' }] } });
  builder.observe({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'sig_2' }] } });
  builder.observe({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Then check the date.', signature: 'sig_3' }, { type: 'text', text: 'Done.' }] } });
  assert.deepEqual(live, [{ type: 'thinking', text: 'Plan the search first.' }, { type: 'thinking', text: 'Then check the date.' }]);
  builder.endTurn({ status: 'completed' });
  assert.deepEqual(entries, [{ type: 'message', role: 'assistant', text: 'Done.' }, { type: 'turn', status: 'completed' }], 'the answer is its text alone');
});

test("a subagent's thinking is left out, as its text is", () => {
  const { live, builder } = heard();
  builder.observe({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'thinking', thinking: 'A helper thinks.', signature: 's' }] } });
  assert.deepEqual(live, []);
});
