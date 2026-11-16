// A run's learning end read across its learning run's last save (store-reads/learning.ts runLearningEnd). The learning
// loop saves its merged or dropped entry and the learning run's end (state and ended_at) in one transaction, so the read
// can see the row from before that save and the journal from after it. The end it serves must be the one the save wrote:
// its `at` the learning run's ended_at, never the proposal's time, so a settled receipt never changes once it reads merged.
import assert from "node:assert/strict";
import { test } from "node:test";

const { runLearningEnd } = await import("../dist/store-reads/learning.js");

const KEPT = Date.parse("2026-11-16T11:19:45.810Z");
const ENDED = Date.parse("2026-11-16T11:19:46.736Z");
const RUN = "torn-run", LEARNING = `${RUN}-learning`;
const verdict = { merge: true, items: [] };
const graded = { kind: "agentrun.learning.graded", data: { source: RUN, verdict, usd: 0, tokens: null, graded: {} } };
const merged = { kind: "agentrun.learning.merged", data: { source: RUN, main: "a1", commit: "b2", files: [], detail: "Learned: Answer prefix" } };
const dropped = { kind: "agentrun.learning.dropped", data: { source: RUN, reason: "checker", detail: "The folder moved on." } };

/** A store whose learning run ends with `end` (the loop's last entry) at the moment its journal is read: the row read
 *  before that read is the running one, every row read after it the ended one. `rowReads` counts the learning run's reads. */
function tornStore(end) {
  let saved = false;
  const counts = { rowReads: 0 };
  const running = { id: LEARNING, agentId: "a", state: "running", epoch: 1, startedAt: KEPT, endedAt: null };
  const ended = { ...running, state: "ended", epoch: 2, endedAt: ENDED };
  const page = (items) => async () => ({ items });
  const store = {
    runs: { get: async (id) => (id === LEARNING ? (counts.rowReads++, saved ? ended : running) : undefined) },
    learning: { proposal: async (id) => (id === RUN ? { runId: RUN, round: 1, agentId: "a", turn: null, proposal: { state: "proposed", proposal: { notes: [] } }, learningRunId: LEARNING, createdAt: KEPT } : undefined) },
    readJournal: (id) => {
      assert.equal(id, LEARNING);
      // The loop's save lands here, between the row read and the journal read.
      saved = true;
      const entries = [graded, end].map((entry, i) => ({ id: i + 1, conversationId: 1, ...entry }));
      return { scanConversations: page([{ id: 1 }]), scanEntries: page(entries), scanTasks: page([]), scanSubmissions: page([]) };
    },
  };
  return { store, counts };
}

for (const [state, end] of [["merged", merged], ["dropped", dropped]]) test(`a ${state} end read across its save is at the learning run's ended_at, never the proposal's time`, async () => {
  const { store, counts } = tornStore(end);
  const learning = await runLearningEnd(store, RUN);
  assert.equal(learning.state, state);
  assert.equal(learning.at, new Date(ENDED).toISOString(), "the end the save wrote, with its ended_at");
  assert.equal(counts.rowReads, 2, "the row is read again once, after the journal showed the end it had not seen");
});

test("a learning run that has not ended reads proposed at the proposal's time, its row read once", async () => {
  const counts = { rowReads: 0 };
  const running = { id: LEARNING, agentId: "a", state: "running", epoch: 1, startedAt: KEPT, endedAt: null };
  const store = {
    runs: { get: async () => (counts.rowReads++, running) },
    learning: { proposal: async () => ({ runId: RUN, round: 1, agentId: "a", turn: null, proposal: { state: "proposed", proposal: { notes: [] } }, learningRunId: LEARNING, createdAt: KEPT }) },
    readJournal: () => ({ scanConversations: async () => ({ items: [{ id: 1 }] }), scanEntries: async () => ({ items: [{ id: 1, conversationId: 1, ...graded }] }), scanTasks: async () => ({ items: [] }), scanSubmissions: async () => ({ items: [] }) }),
  };
  const learning = await runLearningEnd(store, RUN);
  assert.deepEqual([learning.state, learning.at, counts.rowReads], ["proposed", new Date(KEPT).toISOString(), 1]);
});
