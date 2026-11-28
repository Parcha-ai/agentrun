// A Claude Agent session resumed in a fresh process answers the call its last answer left on that answer's facts, which
// the session's journal kept (harness.ts drive: journalTurn): the resumed call gets only what the turn left, never the
// share a budget that knows nothing would give it. On the scripted Agent SDK (./testing) behind the session's real
// proxy: no key, no network, no Claude Agent CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { answerReserve, journalTurn, NativeJournal, TurnBudget } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-turn-journal-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const MODELS = { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} };
const WINDOW = 16_384;
/** The input the interrupted answer's request held: what it leaves its one call, in characters. */
const HELD = 12_000;
const LEFT = (WINDOW - HELD - answerReserve(WINDOW)) * 3;
const RESULT = 10_000;
/** The Claude transcript's lines on the log (each journal batch's `claude` stream), as a resume loads them. */
const claudeLines = (records) =>
  records.flatMap((record) => (record.kind === 'kernel.start' && record.data?.name === 'journal' ? (record.data.input?.streams?.claude?.entries ?? []).map((entry) => entry.data) : []));
/** The text of the result line that answers `callId`. */
const answerOf = (records, callId) =>
  claudeLines(records)
    .flatMap((line) => (line?.type === 'user' && Array.isArray(line.message?.content) ? line.message.content : []))
    .filter((c) => c?.tool_use_id === callId)
    .map((c) => (typeof c.content === 'string' ? c.content : (c.content ?? []).map((part) => part?.text ?? '').join('')));

/** The session's journal given an answer's facts, as the process that read it journaled them before it stopped. */
async function journaled(store, key, facts) {
  const drive = await openDrive({ writer: await store.open(key), signal: new AbortController().signal });
  const journal = new NativeJournal(drive);
  const turn = new TurnBudget();
  journalTurn(turn, journal);
  turn.open(facts);
  await journal.flush();
}

/** A session of the adapter over `store`, whose "model" calls `lookup` on "go" (and says the rest). */
async function openOn(t, store, { gate, signal }) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ mirrorLagMs: 10, script: (text) => (text === 'go' ? 'call lookup {"q":"x"}' : undefined) }),
  });
  const tool = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'never', call: async () => ({ text: `START ${'r'.repeat(RESULT - 6)}` }) };
  const io = { writer: await store.open('s1'), models: MODELS, signal, dir: scratch(), onEvent: () => {}, gate };
  return adapter.open({ key: 's1', label: 'root', system: [], tools: [tool], context: 'fresh', contextWindow: WINDOW }, io);
}

test("a parked call resumed in a fresh process gets only what its answer left (12,000 of 16,384 held), not a fresh budget's share", async (t) => {
  // MUTATION: drive without journalTurn resumes the call on a budget that knows nothing: its 10k result goes back whole.
  const store = memorySessionStore();
  // First claim: the gate parks the call, and the run's signal stops the session (as the runner does on a park).
  const parking = new AbortController();
  const asked = [];
  const first = await openOn(t, store, { signal: parking.signal, gate: async (call) => { asked.push(call.callId); setImmediate(() => parking.abort(new Error('parked'))); return { park: true }; } });
  await first.send('go');
  await first.turnEnd().catch(() => undefined);
  await first.close();
  assert.equal(asked.length, 1, 'asked once');
  await journaled(store, 's1', { inputTokens: HELD, outputTokens: 0, calls: 1 });

  // The resume, a fresh adapter session: the call runs on the journal's turn.
  const second = await openOn(t, store, { signal: new AbortController().signal, gate: async () => 'allow' });
  try {
    await second.recover();
    assert.equal((await second.turnEnd()).status, 'completed');
  } finally {
    await second.close();
  }
  const [text] = answerOf(await store.read('s1'), asked[0]);
  assert.ok(typeof text === 'string' && text.startsWith('START'), `its result is in the transcript: ${String(text).slice(0, 200)}`);
  assert.ok(text.length <= LEFT, `${text.length} characters, past what the turn left (${LEFT})`);
});
