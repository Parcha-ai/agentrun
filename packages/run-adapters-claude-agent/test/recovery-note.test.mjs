// The recovery note a resumed session gets after a crash: the harness's own account of the cut-off turn rides in the
// resuming drive's system prompt, never in a user message the model could answer back to the user. A resumed session
// sends the system prompt recorded at its start unless that launch passes `snapshot: false` (measured on the real CLI,
// Agent SDK 0.3.286; the fake follows the same rule), so the resuming drive alone passes false.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { createHarnessRunner, HarnessRunError } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-claude-agent';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-claude-agent/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-recovery-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
/** The harness's user turn that resumes a cut-off turn when the user said nothing new (harness.ts RECOVERY_NUDGE). */
const RECOVERY_NUDGE = 'Continue.';
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
const request = { kind: 'agent', label: 'task', system: [], user: 'Search, then answer.', schema: SCHEMA, tools: ['search'], step: { sessionId: 'recovery', attempt: 0, earlierSessionIds: [] } };

/** An adapter over the fake SDK, with what each query sent as its system prompt and each user message it consumed. */
async function claude(t, { script, sessionsDir }) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const systems = [];
  const users = [];
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: (_model, usage) => (usage.input + usage.output) / 1e6,
    sessionsDir,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ remoteModel: true, mirrorLagMs: 10, script, onSystem: (s) => systems.push(s), onMessage: (m) => users.push(m.text) }),
  });
  return { adapter, systems, users };
}

/** A paid search that takes `ms`, stopping (failing) if its signal aborts first. */
function paidSearch(ms) {
  const search = { runs: 0, started: undefined };
  let started;
  search.started = new Promise((resolve) => { started = resolve; });
  search.tool = {
    name: 'search', description: 'Search the web (paid per call).', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe',
    call: (args, { signal }) => {
      search.runs += 1;
      started();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ text: `results for ${args.q}` }), ms);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('the search was cut off')); }, { once: true });
      });
    },
  };
  return search;
}

test('after a crash mid-turn, the recovery note is in the resuming drive\'s system prompt (sent, not the recorded one) and in no user message; the user turn is a bare nudge', async (t) => {
  const dir = join(mkdtempSync(join(ROOT, 't-')), 'sessions');
  const store = memorySessionStore();
  const search = paidSearch(400);

  // The first process: the search starts, and a pause cuts the turn off.
  const first = await claude(t, { script: ['call search {"q":"x"}'], sessionsDir: dir });
  const node = createHarnessRunner(first.adapter, { store, tools: [search.tool] });
  const running = node(request).then(() => 'delivered', (error) => error);
  await search.started;
  await node.stop({ drainMs: 15_000 });
  const stopped = await running;
  assert.ok(stopped instanceof HarnessRunError && stopped.reason === 'aborted', String(stopped));
  // The session's first launch records its prompt (snapshot on): the one a later resume sends unless it passes false.
  assert.deepEqual(first.systems.map((s) => [s.resumed, s.snapshot]), [[false, true]], 'the first drive records its prompt');
  assert.ok(!first.systems[0].sent.includes('[Recovery]'));

  // The next process resumes the cut-off turn.
  const next = await claude(t, { script: ['call submit {"value":{"answer":"from the record"}}', 'call submit {"value":{"answer":"from the record"}}'], sessionsDir: dir });
  assert.deepEqual(await createHarnessRunner(next.adapter, { store, tools: [search.tool] })(request), { answer: 'from the record' });
  const [resuming] = next.systems;
  assert.ok(resuming?.resumed, 'the next drive resumes the session');
  assert.equal(resuming.snapshot, false, 'the resuming drive renders its own system prompt: with snapshot on, a resume sends the recorded one and the note is dropped');
  assert.match(resuming.sent, /\[Recovery\] Your previous turn was interrupted/, 'the note is in the system prompt the resumed session sends');
  assert.match(resuming.sent, /search\(\{"q":"x"\}\), call \S+: completed\. Its result:\s+results for x/, 'with what the log records about the call');
  for (const text of [...first.users, ...next.users]) assert.ok(!text.includes('[Recovery]'), `no user message carries the note: ${text.slice(0, 200)}`);
  assert.equal(next.users[0], RECOVERY_NUDGE, 'the resuming user turn is the bare nudge: the user said nothing new');
  assert.ok(!/interrupted|recovery|resumed/i.test(next.users[0]), 'and the nudge says nothing of the recovery');
});
