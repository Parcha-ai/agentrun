// The turn budget across a restart (process/turn-budget.ts journalTurn): a CLI's process that stops in a turn (a park,
// a crash) leaves calls of its answer unanswered, and the next process answers them on its resume (resumeUnstartedCalls)
// with a budget of its own. Each answer's facts (its input and output tokens, its calls) and each result's length as it
// was handed go to the session's journal as they happen, and a budget that has read nothing yet takes them back from
// there before any call claims: the pending calls split what the interrupted answer left, as they would have before the
// restart, and a result handed before it still holds its part.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import * as processExports from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const { NativeJournal, resumeUnstartedCalls, toolBridge, TurnBudget, answerReserve } = processExports;
/** The journal of a turn budget: before this change there is none, and a budget restarts knowing nothing (a no-op here). */
const journalTurn = processExports.journalTurn ?? (() => {});
const WINDOW = 16_384;
const CHARS_PER_TOKEN = 3;
const HELD = 4_000;
/** What the turn has for its results, in characters: the window less what the request held and the room kept for the answer. */
const ROOM = (WINDOW - HELD - answerReserve(WINDOW)) * CHARS_PER_TOKEN;

const driveOf = async (store, key) => openDrive({ writer: await store.open(key), signal: new AbortController().signal });
const bigTool = (size) => ({ name: 'lookup', description: 'Looks up.', inputSchema: { type: 'object' }, replay: 'safe', execute: async () => `START ${'r'.repeat(size - 6)}` });
const dangling = (...ids) => ids.map((callId) => ({ callId, tool: 'lookup', args: { q: callId } }));

/** The calls `ids` answered on a resume in a fresh process (a fresh budget, journaled), and the lengths they were handed at. */
async function resumed(store, key, ids, size) {
  const drive = await driveOf(store, key);
  const turn = new TurnBudget();
  journalTurn(turn, new NativeJournal(drive));
  const bridge = toolBridge(drive, [bigTool(size)], { budget: { contextWindow: WINDOW, turn } });
  const lengths = [];
  await resumeUnstartedCalls(drive, bridge, dangling(...ids), async (_call, outcome) => void lengths.push(outcome.text.length));
  return lengths;
}

test("a restart in a turn: its four pending 10k results split what the interrupted answer (4,000 tokens held, four calls) left, never whole", async () => {
  // MUTATION: a recovered budget that is not given the answer's facts hands each result whole: 4 x 10,000 past the room.
  const store = memorySessionStore();
  const first = await driveOf(store, 'r1');
  const journal = new NativeJournal(first);
  const turn = new TurnBudget();
  journalTurn(turn, journal);
  turn.open({ inputTokens: HELD, outputTokens: 0, calls: 4 });
  await journal.flush();
  // The process stops before any call runs (its gate parked them); the next one resumes them.
  const lengths = await resumed(store, 'r1', ['c1', 'c2', 'c3', 'c4'], 10_000);
  assert.equal(lengths.length, 4);
  const total = lengths.reduce((a, b) => a + b, 0);
  assert.ok(total <= ROOM, `the four together (${lengths.join(', ')}) fit what the turn left (${ROOM})`);
  for (const length of lengths) assert.ok(length < 10_000, `each cut to its share, never whole: ${lengths.join(', ')}`);
});

test("a restart in a turn whose calls were not counted: the results handed before it keep their part, and a pending one gets only what is left", async () => {
  // MUTATION: a recovered budget that takes back the answer's facts but not what was handed: the pending call gets the whole room again.
  const store = memorySessionStore();
  const first = await driveOf(store, 'r2');
  const journal = new NativeJournal(first);
  const turn = new TurnBudget();
  journalTurn(turn, journal);
  // An answer whose calls were not counted (its stream not read for them): each call claims what is left, in turn.
  turn.open({ inputTokens: HELD, outputTokens: 0 });
  const bridge = toolBridge(first, [bigTool(10_000)], { budget: { contextWindow: WINDOW, turn } });
  const before = [await bridge.call('lookup', { q: 'c1' }, 'c1'), await bridge.call('lookup', { q: 'c2' }, 'c2')].map((r) => r.text.length);
  await journal.flush();
  const [after] = await resumed(store, 'r2', ['c3'], 10_000);
  const handed = before.reduce((a, b) => a + b, 0);
  assert.ok(handed + after <= ROOM, `handed before the restart ${before.join(', ')}, after it ${after}: together within ${ROOM}`);
  assert.ok(after <= ROOM - handed, `the pending call gets only what is left (${ROOM - handed}): ${after}`);
});

test("a budget that has read an answer is not taken back to the journal's: a later drive of the same process keeps its own turn", async () => {
  // The session's journal holds an earlier answer's facts (4,000 tokens held).
  const store = memorySessionStore();
  const first = await driveOf(store, 'r3');
  const journal = new NativeJournal(first);
  const earlier = new TurnBudget();
  journalTurn(earlier, journal);
  earlier.open({ inputTokens: HELD, outputTokens: 0, calls: 1 });
  await journal.flush();
  // This budget has read a later answer of its own (12,000 tokens held): 864 characters left for its one call.
  const turn = new TurnBudget();
  turn.open({ inputTokens: 12_000, outputTokens: 0, calls: 1 });
  const next = await driveOf(store, 'r3');
  journalTurn(turn, new NativeJournal(next));
  assert.equal(turn.claim('c1', WINDOW), (WINDOW - 12_000 - answerReserve(WINDOW)) * CHARS_PER_TOKEN, "its own answer's room, not the journal's");
});

test("a restart right after results were handed, before anything else was written: those results keep their part, and a pending call gets only what is left", async () => {
  // MUTATION: a settled length written but not flushed before its result goes back: lost with the process, the pending
  // call claims the room the handed results already took.
  const store = memorySessionStore();
  // A store whose writes land a moment after they are asked (as a database's do): a write still on its way when the
  // process stops is lost with it (the next process's open fences it).
  const writer = await store.open('r4');
  const first = await openDrive({ writer: { ...writer, append: async (records) => (await new Promise((r) => setImmediate(r)), writer.append(records)) }, signal: new AbortController().signal });
  const journal = new NativeJournal(first);
  const turn = new TurnBudget();
  journalTurn(turn, journal);
  // An answer whose calls were not counted: each call claims what is left, in turn.
  turn.open({ inputTokens: HELD, outputTokens: 0 });
  const bridge = toolBridge(first, [bigTool(10_000)], { budget: { contextWindow: WINDOW, turn } });
  const before = [await bridge.call('lookup', { q: 'c1' }, 'c1'), await bridge.call('lookup', { q: 'c2' }, 'c2')].map((r) => r.text.length);
  // The process stops here: no flush after the results went back.
  const [after] = await resumed(store, 'r4', ['c3'], 10_000);
  const handed = before.reduce((a, b) => a + b, 0);
  assert.ok(handed + after <= ROOM, `handed before the restart ${before.join(', ')}, after it ${after}: together within ${ROOM}`);
});
