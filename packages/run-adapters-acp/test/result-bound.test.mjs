// A host tool's result on the ACP adapter passes the kernel's tool bridge on its way to the agent, which holds it to the
// model's context window when the host knows it (the adapter's contextWindow option, or the session's own,
// SessionSpec.contextWindow): a 16k model gets at most a quarter of its window at three characters a token, cut with a
// note saying why; with no window, the host's fixed bound (HOST_RESULT_MAX_CHARS) as before. The fake ACP agent only:
// no binary, no model, no network beyond loopback.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { acpAdapter } from '@parcha/agentrun-harness-acp';
import { fakeRecipe, scratch, tool } from './helpers.mjs';

/** The per-model bound of a 16,384-token window (the kernel's resultMaxChars): a quarter of it at three characters a token. */
const SMALL_MAX = 12_288;
const BIG = `START-OF-RESULT ${'x'.repeat(50_000)}`;
const WINDOW_NOTE = /\n\[kept \d+ of 50016 characters: the result was cut to fit this model's context window\./;

/** The end the host heard of one call of a tool answering BIG, on a session whose window is `options.contextWindow` (the
 *  adapter's) or `spec` (the session's own). */
async function ended(t, { options = {}, spec = {} } = {}) {
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'lookup', args: {} }, { say: 'done' }] });
  const { countFile: _, ...plain } = recipe;
  const adapter = acpAdapter({ recipe: plain, sessionsDir: join(scratch(), 'sessions'), ...options });
  const events = [];
  const store = memorySessionStore();
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: (event) => events.push(event) };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [tool('lookup', () => BIG, 'safe')], context: 'fresh', ...spec }, io);
  t.after(() => session.close());
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'completed', end.error);
  const ends = events.filter((e) => e.type === 'tool_end' && e.name === 'lookup');
  assert.equal(ends.length, 1, 'one end of the call');
  return ends[0];
}

test("ACP, a model with a 16k window (the adapter's option): a 50k result reaches the agent cut to the per-model bound, saying why", async (t) => {
  const end = await ended(t, { options: { contextWindow: 16_384 } });
  assert.ok(end.result.length <= SMALL_MAX, `${end.result.length} characters, past ${SMALL_MAX}`);
  assert.match(end.result, WINDOW_NOTE);
  assert.ok(end.result.startsWith('START-OF-RESULT '), 'its start kept');
  assert.equal(end.truncated, true);
});

test("ACP, the session's own 16k window wins over the adapter's: the same cut", async (t) => {
  const end = await ended(t, { options: { contextWindow: 1_000_000 }, spec: { contextWindow: 16_384 } });
  assert.ok(end.result.length <= SMALL_MAX, `${end.result.length} characters, past ${SMALL_MAX}`);
  assert.match(end.result, WINDOW_NOTE);
});

test('ACP, no window known: a 50k result reaches the agent whole, within the host bound', async (t) => {
  const end = await ended(t);
  assert.equal(end.result, BIG);
});
