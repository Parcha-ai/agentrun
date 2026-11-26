// An ACP session resumed in a fresh process answers the call its last answer left on that answer's facts, which the
// session's journal kept (harness.ts driveOnce: journalTurn): the resumed call gets only what the turn left, never the
// share a budget that knows nothing would give it. On the fake ACP agent: no binary, no model, no network.
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { answerReserve, journalTurn, NativeJournal, TurnBudget } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { CALL_STREAM } from '../dist/harness.js';
import { fakeRecipe, openSession, resolvedRecords, scratch, tool } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
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

test("a parked call resumed in a fresh process gets only what its answer left (12,000 of 16,384 held), not a fresh budget's share", async (t) => {
  // MUTATION: driveOnce without journalTurn resumes the call on a budget that knows nothing: its 10k result goes back whole.
  const store = memorySessionStore();
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'lookup' }, { sayLastResult: true }] });
  const lookup = tool('lookup', () => `START ${'r'.repeat(RESULT - 6)}`);
  const options = { contextWindow: WINDOW };
  // The first runner: the agent calls, the gate parks, the runner lets the session go.
  const asked = [];
  let parked;
  const wasParked = new Promise((resolve) => (parked = resolve));
  const first = await openSession(t, recipe, { store, tools: [lookup], options, gate: async (call) => (asked.push(call.callId), parked(), { park: true }) });
  await first.session.send('go');
  await wasParked;
  first.stop(new Error('the run parked'));
  await first.session.turnEnd().catch(() => undefined);
  await first.session.close();
  await journaled(store, 's1', { inputTokens: HELD, outputTokens: 0, calls: 1 });

  // The next runner, a fresh adapter session: the call runs on the journal's turn.
  const second = await openSession(t, recipe, { store, tools: [lookup], options, gate: async () => 'allow' });
  await second.session.recover();
  await second.session.turnEnd();
  const [answered] = (await resolvedRecords(store, CALL_STREAM)).filter((r) => r?.type === 'answered' && r.callId === asked[0]);
  assert.ok(answered?.text?.startsWith('START'), `the call was answered on the resume: ${JSON.stringify(answered)?.slice(0, 200)}`);
  assert.ok(answered.text.length <= LEFT, `${answered.text.length} characters, past what the turn left (${LEFT})`);
});
