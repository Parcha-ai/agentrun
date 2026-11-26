// An answer that reaches the drive with no stream: the Claude CLI, when a streamed model request stalls (a local model
// still reading its prompt or thinking), asks again without streaming, and its answer comes as whole `assistant`
// messages with no `stream_event` deltas. Its text is still the turn's answer: the live stream says it, once. A message
// whose text did stream is never said twice. Recorded SDK message shapes into the TranscriptBuilder, and one turn through
// the adapter on the scripted Agent SDK (./testing): no key, no network, no Claude Agent CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';
import { TranscriptBuilder } from '../dist/transcript.js';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-whole-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function builder() {
  const live = [];
  const entries = [];
  const b = new TranscriptBuilder({ message: (entry) => entries.push(entry), live: (event) => live.push(event) });
  return { b, live, entries };
}

const event = (ev) => ({ type: 'stream_event', parent_tool_use_id: null, event: ev });
const assistant = (id, block) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', content: [block] } });
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', queued_turn_count: 0 };

test('a whole answer with no stream (thinking, then text) is said live once, as the turn answer', () => {
  const { b, live, entries } = builder();
  // The stalled streamed request: its message began, then nothing came before the CLI gave up on it.
  b.observe(event({ type: 'message_start', message: { id: 'msg_streamed', role: 'assistant', content: [] } }));
  // The non-streaming retry's answer: one assistant message per block, no deltas.
  b.observe(assistant('msg_whole', { type: 'thinking', thinking: 'The user wants one word.' }));
  b.observe(assistant('msg_whole', { type: 'text', text: 'done' }));
  const end = b.observe(result);
  b.endTurn(end);
  assert.deepEqual(live, [{ type: 'text', delta: 'done' }]);
  assert.deepEqual(entries, [{ type: 'message', role: 'assistant', text: 'done' }, { type: 'turn', status: 'completed' }]);
});

test('a streamed answer is said once: its whole assistant message adds nothing live', () => {
  const { b, live } = builder();
  b.observe(event({ type: 'message_start', message: { id: 'msg_a', role: 'assistant', content: [] } }));
  b.observe(event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }));
  b.observe(assistant('msg_a', { type: 'thinking', thinking: 'hm' }));
  b.observe(event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'do' } }));
  b.observe(event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ne' } }));
  b.observe(assistant('msg_a', { type: 'text', text: 'done' }));
  b.endTurn(b.observe(result));
  assert.deepEqual(live, [{ type: 'text', delta: 'do' }, { type: 'text', delta: 'ne' }]);
});

test('a stream cut after some text, then answered whole: the whole answer is a message of its own', () => {
  const { b, live } = builder();
  b.observe(event({ type: 'message_start', message: { id: 'msg_cut', role: 'assistant', content: [] } }));
  b.observe(event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me' } }));
  b.observe(assistant('msg_whole', { type: 'text', text: 'done' }));
  b.endTurn(b.observe(result));
  assert.deepEqual(live, [{ type: 'text', delta: 'Let me' }, { type: 'text_end' }, { type: 'text', delta: 'done' }]);
});

test('through the adapter: a turn answered whole (thinking, then text) says its answer to the host, and ends completed', { timeout: 60_000 }, async (t) => {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ script: [`whole ${JSON.stringify({ thinking: 'The user wants one word.', text: 'done' })}`] }),
  });
  const store = memorySessionStore();
  const events = [];
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, dir: mkdtempSync(join(ROOT, 't-')), onEvent: (event) => events.push(event) };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, io);
  try {
    await session.send('Reply with the word done.');
    assert.equal((await session.turnEnd()).status, 'completed');
  } finally {
    await session.close();
  }
  assert.deepEqual(events.filter((event) => event.type === 'text' || event.type === 'text_end' || event.type === 'turn_end'), [{ type: 'text', delta: 'done' }, { type: 'turn_end', status: 'completed' }]);
});
