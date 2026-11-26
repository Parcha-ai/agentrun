// Claude Code on a person's login: no model proxy sees its requests, so the kernel's turn budget hears each answer from
// the CLI's own stream (login.ts loginBooking), as it books it: the request's input tokens (its cached input included)
// and the answer's output from `message_start` and `message_delta`, and the calls it made from its `tool_use` blocks.
// So an answer's parallel calls split what the window has left, as on a provider. The stand-in SDK and CLI only: no
// network, no binary.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeSdk } from '@parcha/agentrun-harness-claude/testing';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-login-turn-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const WINDOW = 16_384;
/** The answer's request: 2,000 tokens of new input, 8,000 read from the cache. */
const USAGE = { input_tokens: 2_000, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 0, output_tokens: 12 };
const HELD = 10_000 + 12;
/** The room a 16k window keeps for the model's answer (the kernel's answerReserve). */
const RESERVE = 4_096;
const SIZE = 10_000;

/** A login whose directories no one may open: anything that reads them fails. */
function sealedLogin() {
  const base = mkdtempSync(join(ROOT, 'login-'));
  const login = { dir: join(base, 'login'), profiles: join(base, 'login', 'anthropic') };
  mkdirSync(login.profiles, { recursive: true });
  chmodSync(login.profiles, 0o000);
  chmodSync(login.dir, 0o000);
  after(() => { chmodSync(login.dir, 0o700); chmodSync(login.profiles, 0o700); });
  return login;
}

test("on a login, an answer's two parallel 10k results split what a 16k window has left after 10,000 tokens held (8,000 of them cached)", async () => {
  const tool = (name) => ({ name, description: `Answers ${SIZE} characters.`, inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: `START-${name} `.padEnd(SIZE, 'r') }) });
  const tools = [tool('read_a'), tool('read_b')];
  const sdk = fakeSdk({ mirrorLagMs: 10, script: [`parallel ${JSON.stringify({ usage: USAGE, calls: tools.map((t) => ({ name: t.name, args: {} })) })}`] });
  const adapter = claudeAgentAdapter({ model: 'claude-haiku-5-5', login: sealedLogin(), sessionsDir: join(mkdtempSync(join(ROOT, 'run-')), 'sessions'), standIn: { command: process.execPath }, sdk });
  const spec = { key: 'login-turn', label: 'login-turn', system: ['Read both.'], tools, context: 'fresh', contextWindow: WINDOW };
  const store = memorySessionStore();
  const events = [];
  const models = { beforeRequest: async () => ({ turn: 1 }), afterRequest: async () => {} };
  const session = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  try {
    await session.send('Read both.');
    assert.equal((await session.turnEnd()).status, 'completed');
  } finally {
    await session.close();
  }
  const ended = events.filter((e) => e.type === 'tool_end');
  assert.deepEqual(ended.map((e) => e.name).sort(), ['read_a', 'read_b'], 'both calls ended');
  const texts = ended.map((e) => e.result);
  const total = HELD + Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 3);
  assert.ok(total <= WINDOW - RESERVE, `${total} tokens once the results are in (${texts.map((x) => x.length)} characters): past the window less the ${RESERVE} kept for the answer`);
  for (const [i, text] of texts.entries()) {
    assert.match(text, /^START-read_/, 'each keeps its start');
    assert.match(text, /\n\[kept \d+ of 10000 characters: [^\n]*context window[^\n]*\]$/, `each cut to its share, saying so: ${JSON.stringify(text.slice(-160))}`);
    assert.equal(ended[i].truncated, true);
  }
  assert.ok(Math.abs(texts[0].length - texts[1].length) < 200, `an even split: ${texts.map((x) => x.length)}`);
});
