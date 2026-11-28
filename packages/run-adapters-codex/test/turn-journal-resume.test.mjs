// A Codex session resumed in a fresh process answers the call its last answer left on that answer's facts, which the
// session's journal kept (harness.ts driveOn: journalTurn): the resumed call gets only what the turn left, never the
// share a budget that knows nothing would give it. On the stand-in app-server (fake-app-server.mjs) behind the
// session's real proxy. No key, no network, no Codex.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { answerReserve, journalTurn, NativeJournal, TurnBudget } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-turn-journal-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODELS = { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} };
const WINDOW = 16_384;
/** The input the interrupted answer's request held: what it leaves its one call, in characters. */
const HELD = 12_000;
const LEFT = (WINDOW - HELD - answerReserve(WINDOW)) * 3;
const RESULT = 10_000;

/** The session's journal given an answer's facts, as the process that read it journaled them before it stopped. */
async function journaled(store, key, facts) {
  const drive = await openDrive({ writer: await store.open(key), signal: new AbortController().signal });
  const journal = new NativeJournal(drive);
  const turn = new TurnBudget();
  journalTurn(turn, journal);
  turn.open(facts);
  await journal.flush();
}

/** The rollout lines the session mirrored (its last thread's), parsed. */
async function rolloutOf(store, key) {
  const drive = await openDrive({ writer: await store.open(key), signal: new AbortController().signal });
  const journal = new NativeJournal(drive);
  const thread = journal.records('codex.thread').at(-1)?.data;
  return thread ? (await journal.read(`rollout:${thread.threadId}`)).map((record) => JSON.parse(record.data)) : [];
}

test("a parked call resumed in a fresh process gets only what its answer left (12,000 of 16,384 held), not a fresh budget's share", async (t) => {
  // MUTATION: driveOn without journalTurn resumes the call on a budget that knows nothing: its 10k result goes back whole.
  const dir = mkdtempSync(join(ROOT, 'park-'));
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify(['call lookup {"q":"x"}']));
  const adapter = codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    price: () => 0,
    sessionsDir: join(dir, 'sessions'),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_SCRIPT: file } },
  });
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'never', call: async () => ({ text: `START ${'r'.repeat(RESULT - 6)}` }) };
  const spec = { key: 's1', label: 'root', system: [], tools: [lookup], context: 'fresh', contextWindow: WINDOW };
  const store = memorySessionStore();

  // The first claim: the gate parks the call, and the run lets the session go.
  const asked = [];
  const first = new AbortController();
  let parked;
  const wasParked = new Promise((resolve) => (parked = resolve));
  const a = await adapter.open(spec, { writer: await store.open('s1'), models: MODELS, signal: first.signal, onEvent: () => {}, gate: async (call) => { asked.push(call); parked(); return { park: true }; } });
  t.after(() => a.close());
  await a.send('go');
  await wasParked;
  first.abort();
  await a.turnEnd().catch(() => undefined);
  await a.close();
  const callId = asked[0].callId;
  await journaled(store, 's1', { inputTokens: HELD, outputTokens: 0, calls: 1 });

  // The next claim, a fresh adapter session: the call runs on the journal's turn.
  const b = await adapter.open(spec, { writer: await store.open('s1'), models: MODELS, signal: new AbortController().signal, onEvent: () => {}, gate: async () => 'allow' });
  t.after(() => b.close());
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();
  const [output] = (await rolloutOf(store, 's1')).filter((line) => line.payload?.type === 'function_call_output' && line.payload.call_id === callId).map((line) => line.payload.output);
  assert.ok(typeof output === 'string' && output.startsWith('START'), `its output reached Codex: ${String(output).slice(0, 200)}`);
  assert.ok(output.length <= LEFT, `${output.length} characters, past what the turn left (${LEFT})`);
});
