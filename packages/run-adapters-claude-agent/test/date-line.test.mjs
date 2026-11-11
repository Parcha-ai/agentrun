// A session resumed on a later day is told that day. The CLI records a session's system prompt at its first request and
// every resume sends the record (the snapshot rule, recovery-note.test.mjs), so a date the host put in the system prompt
// stays the first day's. The day rides in the turn instead: the first message the CLI is sent on a day its model was not
// told starts with the date line (harness.ts dateLine). The session's first day is its recorded prompt's; the host's log
// keeps the person's words.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { foldSession } from '@parcha/agentrun-kernel/kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-date-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const SYSTEM = 'Today is 2026-11-11 (UTC). You are running on AgentRun.';
const spec = { key: 'step:dated', label: 'chat', system: [SYSTEM], tools: [], context: 'fresh' };
const models = { beforeRequest: async () => {}, afterRequest: async () => {} };

/** One process's adapter on the fake SDK, reading the day from `clock.now`, with what it sent: each user message the CLI
 *  consumed, and each launch's system prompt by the CLI's snapshot rule. */
async function processOn(t, clock, sessionsDir) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const users = [];
  const systems = [];
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: (_model, usage) => (usage.input + usage.output) / 1e6,
    sessionsDir,
    standIn: { command: process.execPath },
    now: () => clock.now,
    sdk: fakeSdk({ remoteModel: true, mirrorLagMs: 10, onSystem: (s) => systems.push(s), onMessage: (m) => users.push(m.text) }),
  });
  return { adapter, users, systems };
}

async function turns(proc, store, texts) {
  const session = await proc.adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  for (const text of texts) {
    await session.send(text);
    assert.equal((await session.turnEnd()).status, 'completed', `the turn ${text} completed`);
  }
  await session.close();
}

test('a session resumed on a later day is told that day once, in its first message of the day; its first day is its recorded prompt\'s', async (t) => {
  const store = memorySessionStore();
  const dir = mkdtempSync(join(ROOT, 's-'));
  const clock = { now: new Date('2026-11-11T09:00:00Z') };

  // Day one: the session's first launch records its system prompt, which names the day. No turn carries a line.
  const first = await processOn(t, clock, dir);
  await turns(first, store, ['first', 'second']);
  assert.deepEqual(first.users, ['first', 'second'], 'on the recorded day no message carries the date');
  assert.deepEqual(first.systems.map((s) => [s.resumed, s.snapshot]), [[false, true], [true, true]], 'the first launch records its prompt; the next turn\'s resumes it');

  // Day two, a new process: the resume sends the recorded prompt (the cache prefix holds), and its first message says today.
  clock.now = new Date('2026-11-12T00:00:05Z');
  const next = await processOn(t, clock, dir);
  await turns(next, store, ['third', 'fourth']);
  assert.ok(next.systems.every((s) => s.resumed && s.snapshot && s.sent.includes(SYSTEM)), `the resume sends the recorded prompt: ${JSON.stringify(next.systems.map((s) => [s.resumed, s.snapshot]))}`);
  assert.deepEqual(next.users, ['Today is 2026-11-12 (UTC).\n\nthird', 'fourth'], 'the first message on the new day carries it, the next does not');

  // Later the same day, another process: the day was told, in a message the CLI's transcript holds. No line again.
  clock.now = new Date('2026-11-12T23:59:00Z');
  const third = await processOn(t, clock, dir);
  await turns(third, store, ['fifth']);
  assert.deepEqual(third.users, ['fifth'], 'a day told stays told across processes');

  // The host's log keeps the person's words: the line is in the CLI's transcript only.
  const said = foldSession(spec.key, await store.read(spec.key)).submissions.map((s) => s.text);
  assert.deepEqual(said, ['first', 'second', 'third', 'fourth', 'fifth']);
});
