// A content-filtered turn, then a follow-up message on the same session: the follow-up is answered, never refused. Once
// the model proxy tells the harness that a turn's answer stopped, it refuses the session's answer requests until the
// harness opens its next turn (ModelProxy.openTurn); claude-agent's harness halts the drive on the stop, and its next
// turn runs on a fresh drive whose proxy refuses nothing. This pins that: if the CLI or its proxy ever outlived the
// halted drive, the follow-up would be refused here. The scripted Agent SDK with its model the provider's (remoteModel),
// through the session's real proxy to a scripted provider: no key, no network, no Claude Agent CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-filter-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const FILTERED = 'content_filter: the model provider stopped this answer';

/** A Messages stream of `text`, ending whole (end_turn) or on the provider's refusal (its content filter). */
const stream = (text, refused) => [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: refused ? 'refusal' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

test('claude-agent: a content-filtered turn, then a follow-up message on the same session, is answered', { timeout: 60_000 }, async (t) => {
  const seen = [];
  const fetch = async () => {
    seen.push(seen.length);
    return new Response(stream(seen.length === 1 ? 'Partly' : 'Answered.', seen.length === 1), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    price: () => 0,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ remoteModel: true }),
    fetch,
  });
  const store = memorySessionStore();
  const events = [];
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, dir: mkdtempSync(join(ROOT, 's-')), onEvent: (event) => events.push(event) };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, io);
  // Bounded: a session that cannot close (a drive that never ends) fails the file in seconds, never holds the run.
  t.after(() => Promise.race([session.close(), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]));
  // A turn that never ends fails here in words, not by hanging the file.
  const ended = async (what) => {
    let timer;
    const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} never ended; events ${JSON.stringify(events)}; requests ${seen.length}`)), 20_000)));
    try {
      return await Promise.race([session.turnEnd(), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  await session.send('first');
  assert.deepEqual(await ended('the filtered turn'), { status: 'failed', error: FILTERED }, 'the filtered turn fails in the filter words');
  await session.send('again');
  assert.deepEqual(await ended('the follow-up'), { status: 'completed' }, 'the follow-up is answered');
  assert.equal(seen.length, 2, "the follow-up's answer request reached the provider");
  assert.match(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /Answered\./);
});
