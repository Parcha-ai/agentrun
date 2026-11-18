// GET /stats's `learning` (how the runs that tried to learn fared), read from the one store (store-reads/learning.ts
// learningCountsOverStore): the same counts learning-run.ts learningStats gives over the same runs and the same filter,
// each run's learning its end (runLearningEnd). One store holds a run of each kind the counts tell apart: merged by its
// own end, dropped by the checks, dropped when its learning failed, ones dropped with nothing to keep, one whose reason
// an older server gave, and ones the counts leave out (a workflow's, an archived run, an archived agent's, one with no
// learning) or that a filter picks apart (another agent's, one started before the window). An imported run keeps no
// learning in the store, so the store has none to leave out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const learningReads = await import("../dist/store-reads/learning.js");
const { learningStats } = await import("../dist/learning-run.js");
const fn = (module, name) => (typeof module[name] === "function" ? module[name] : () => assert.fail(`${name} is not there`));
const learningCountsOverStore = (...args) => fn(learningReads, "learningCountsOverStore")(...args);

const DAY0 = Date.parse("2026-11-01T09:00:00Z");
const DAY1 = Date.parse("2026-11-02T09:00:00Z");
const DAY2 = Date.parse("2026-11-03T09:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

/** The store: agents and their revisions, then each run started at its time and ended as its case says. */
async function fixture(t) {
  const clock = { now: DAY0 };
  const { store } = await storeOn(t, { clock });
  await store.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.agents.create({ id: "agent-2", name: "Agent two" }, { id: "rev-2", kind: "agentic", body: { instructions: "Answer." } });
  await store.agents.create({ id: "agent-3", name: "Agent three" }, { id: "rev-3", kind: "agentic", body: { instructions: "Answer." } });
  await store.agents.create({ id: "agent-wf", name: "A workflow" }, { id: "rev-wf-1", kind: "workflow", body: {} });
  let n = 0;
  /** A run of `agentId`'s revision `revisionId`, started at `at`, ended keeping `kept` (a learning_proposals row, as the
   *  run's reflect hook writes it). */
  const ended = async (id, at, { agentId = "agent-1", revisionId = "rev-1", kept } = {}) => {
    clock.now = at + n++;
    await store.runs.create({ id, agentId, revisionId });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    const also = kept ? [{ table: "learning_proposals", row: { turn: null, proposal: kept } }] : [];
    await store.runs.update(claim, { state: "ended" }, { also });
  };
  for (const id of ["dropped", "failed"]) await store.agents.create({ id: `agent-${id}`, name: `Agent ${id}` }, { id: `rev-${id}`, kind: "agentic", body: { instructions: "Answer." } });
  const droppedAs = (reason) => ({ state: "dropped", reason, detail: `Dropped: ${reason}` });
  await ended("merged-1", DAY1, { kept: { state: "merged", reason: null, merged: "a".repeat(40), corrections: 1, detail: "Kept 1 correction." } });
  await ended("dropped-checker", DAY1, { agentId: "agent-dropped", revisionId: "rev-dropped", kept: droppedAs("checker") });
  await ended("dropped-failed", DAY2, { agentId: "agent-failed", revisionId: "rev-failed", kept: droppedAs("reflect_failed") });
  await ended("empty-1", DAY2, { kept: droppedAs("empty") });
  await ended("older-reason", DAY2, { kept: droppedAs("a_reason_this_server_never_gives") });
  await ended("workflow-1", DAY2, { agentId: "agent-wf", revisionId: "rev-wf-1", kept: droppedAs("empty") });
  await ended("archived-run", DAY2, { kept: droppedAs("empty") });
  await store.runs.archive("archived-run", true);
  await ended("archived-agent-run", DAY2, { agentId: "agent-3", revisionId: "rev-3", kept: droppedAs("empty") });
  await store.agents.archive("agent-3", true);
  await ended("agent-2-run", DAY2, { agentId: "agent-2", revisionId: "rev-2", kept: droppedAs("cancelled") });
  await ended("before-window", DAY0, { kept: droppedAs("empty") });
  await ended("no-learning", DAY2);
  return store;
}

/** Today's counts over the same store: learningStats over its runs as the server's run list held them (their kind, their
 *  archive, their own or their agent's, their start, their agent), each run's learning its end (runLearningEnd). */
async function today(store, filter) {
  const rows = [];
  const ends = new Map();
  for (const run of await store.runs.list({})) {
    const revision = await store.agents.revision(run.revisionId);
    const agent = await store.agents.get(run.agentId);
    rows.push({ id: run.id, agent: run.agentId, kind: revision?.kind === "workflow" ? "workflow" : "agentic", importedFrom: run.importedFrom ?? undefined, archivedAt: run.archivedAt ?? agent?.archivedAt ?? null, startedAt: iso(run.startedAt) });
    const end = await learningReads.runLearningEnd(store, run.id);
    ends.set(run.id, end ? { state: end.state, reason: end.reason ?? null } : null);
  }
  return learningStats(rows, filter, (row) => ends.get(row.id) ?? null);
}

const FILTERS = [
  ["no filter", {}],
  ["agent-1's runs", { agent: "agent-1" }],
  ["agent-2's runs", { agent: "agent-2" }],
  ["started in [day 1, day 2)", { from: iso(DAY1), to: iso(DAY2) }],
  ["started from day 2", { from: iso(DAY2) }],
  ["started before day 1", { to: iso(DAY1) }],
  ["agent-1's, from day 1", { agent: "agent-1", from: iso(DAY1) }],
];

test("GET /stats's learning counts from the store are today's counts over the same runs, for every filter", async (t) => {
  const store = await fixture(t);
  for (const [name, filter] of FILTERS) {
    assert.deepEqual(await learningCountsOverStore(store, filter), await today(store, filter), name);
  }
});

test("an agent's learning view counts from the store are today's (its runs' counts, less runs), each agent's own", async (t) => {
  const store = await fixture(t);
  const agentCounts = (...args) => fn(learningReads, "agentLearningCountsOverStore")(...args);
  for (const agentId of ["agent-1", "agent-2", "agent-dropped", "agent-failed"]) {
    const { runs: _, ...expected } = await today(store, { agent: agentId });
    assert.deepEqual(await agentCounts(store, agentId), expected, agentId);
  }
  assert.deepEqual(await agentCounts(store, "agent-1"), { merged: 1, dropped: { empty: 2 }, in_progress: 0 }, "agent-1's: merged, two dropped with nothing to keep");
});

test("the store's counts tell each case apart: merged, dropped by reason; the rest left out", async (t) => {
  const store = await fixture(t);
  assert.deepEqual(await learningCountsOverStore(store, {}), { runs: 6, merged: 1, dropped: { checker: 1, reflect_failed: 1, empty: 2, cancelled: 1 }, in_progress: 0 }, "no filter");
  assert.deepEqual(await learningCountsOverStore(store, { agent: "agent-2" }), { runs: 1, merged: 0, dropped: { cancelled: 1 }, in_progress: 0 }, "agent-2's");
  assert.deepEqual(await learningCountsOverStore(store, { from: iso(DAY1), to: iso(DAY2) }), { runs: 2, merged: 1, dropped: { checker: 1 }, in_progress: 0 }, "started on day 1");
  assert.deepEqual(await learningCountsOverStore(store, { to: iso(DAY1) }), { runs: 1, merged: 0, dropped: { empty: 1 }, in_progress: 0 }, "started before day 1");
});
