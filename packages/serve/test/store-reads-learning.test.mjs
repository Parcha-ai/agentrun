// A run's learning end, read from the one store (store-reads/learning.ts runLearningEnd): its kept proposal
// (learning_proposals) and the end of the learning run queued with it (its row and journal), as the server's view of the
// run's learning gave it before the runner graded and merged. The expected values are that view, captured from the
// server's own grade for the same fixtures at 77c24d30db (fixtures/learning-end-golden.json; each run's grade held at
// proposed to keep its proposal, then released): for each, the same proposal and the same verdict go through the
// runner's learning run, and every field the
// view, the run's whole learning and its ledger line read must come back the same. What differs by nature is put aside:
// when it happened, and the merge commit's id (its time is in it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { runLearningEnd } = await import("../dist/store-reads/learning.js");
const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");

const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/learning-end-golden.json", import.meta.url), "utf8"));
/** What a run's learning kept before its end (its given and read notes, its seed count, its answer's time and costs): the run's, not its end's. */
const KEPT = ["given", "read", "seed_notes", "answered_at", "job_cost_usd", "look_back_usd"];
/** The end's fields as compared: its time and the merge commit's id put aside (`merged` read as whether it is a sha). */
const comparable = (learning) => {
  if (!learning) return learning;
  const { at, merged, unread: _unread, ...rest } = learning;
  for (const key of KEPT) delete rest[key];
  return { ...rest, ...(merged === undefined ? {} : { merged: /^[0-9a-f]{40}$/.test(merged) ? "<sha>" : merged }), at: typeof at === "string" && !Number.isNaN(Date.parse(at)) ? "<time>" : at };
};
/** The grader's answer that gives `verdict` again (parseVerdict's input). */
const answerOf = (verdict) => JSON.stringify({
  merge: verdict.merge, reason: verdict.reason,
  items: verdict.items.map((item) => ({ file: item.file, decision: item.pending ? "pending" : item.keep ? "keep" : "drop", ...(item.origin ? { origin: item.origin } : {}), ...(item.question ? { question: item.question } : {}), why: item.why })),
});

/** Scenario `golden`'s run, ended in the store with its kept proposal and its learning run, and that learning run run by
 *  the runner's learning loop on a folder of its own, its grader answering as the server's did. */
async function learnedAs(t, golden) {
  const { store, dir } = await storeOn(t);
  await store.agents.create({ id: golden.agentId, name: golden.agentId }, { id: "rev-1", kind: "agentic", body: { instructions: golden.instructions } });
  await store.runs.create({ id: golden.runId, agentId: golden.agentId, revisionId: "rev-1" });
  const source = await store.claim(golden.runId, "runner-a", { leaseMs: 60_000 });
  const kept = { ...(golden.proposed.problems ? { left: golden.proposed.problems } : {}), state: "proposed", proposal: golden.proposal, detail: golden.proposed.detail };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: `${golden.runId}-learning` } }] });
  const verdict = golden.saved.verdict;
  const ask = async () => {
    if (!verdict) throw new Error("the faux grader failed on purpose");
    return { text: answerOf(verdict), usd: golden.saved.cost_usd?.grade ?? null, tokens: golden.saved.tokens?.grade ?? null };
  };
  const claim = await store.claim(`${golden.runId}-learning`, "runner-b", { leaseMs: 60_000 });
  await learningLoopFactory({ refuse: async () => [], store, data: dir, ask })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  return { store, runId: golden.runId };
}

test("the golden fixtures cover a merge with a held note, origin you, a skill and a draft, a grader's drop with a skill lost, a note the checks left out, and a grader that failed", () => {
  assert.deepEqual(GOLDEN.map((one) => [one.id, one.view.state, one.view.reason]), [
    ["pending", "merged", null], ["you", "merged", null], ["skills", "merged", null], ["dropped", "dropped", "grader"], ["left", "merged", null], ["failed", "dropped", "grade_failed"],
  ]);
});

for (const golden of GOLDEN) {
  test(`${golden.id}: the run's learning end reads from the store as the server's view gave it: its state, words, verdict, what it learned, held, lost and left out, and what the grade spent`, async (t) => {
    const { store, runId } = await learnedAs(t, golden);
    const end = await runLearningEnd(store, runId);
    assert.deepEqual(comparable(end), comparable(golden.saved), "the end as the server saved it");
    // The view and the run's whole learning are the saved end as a person reads it (learning.ts learningView).
    for (const key of ["state", "reason", "detail", "learned", "pending", "skills", "workflows", "problems"]) {
      if (key in golden.view) assert.deepEqual(end[key], golden.view[key], `the view's ${key}`);
    }
    // Its ledger line (usage.ts outcomeOf), which /v2/usage and /v2/stats read: state, reason, the grade's cost and tokens.
    const [line] = golden.ledger;
    assert.deepEqual({ state: end.state, reason: end.reason, cost: end.cost_usd?.grade ?? null, tokens: end.tokens?.grade ?? null }, { state: line.state, reason: line.reason, cost: line.cost, tokens: line.tokens }, "the ledger line's figures");
  });
}

test("a run with no learning reads null; one whose learning run has not ended reads proposed, as the server's view did", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "plain", agentId: "agent-1", revisionId: "rev-1" });
  assert.equal(await runLearningEnd(store, "plain"), null);
  const [golden] = GOLDEN;
  await store.runs.create({ id: "waiting", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("waiting", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "proposed", proposal: golden.proposal, detail: golden.proposed.detail } } }, { table: "learning_run", row: { id: "waiting-learning" } }] });
  const end = await runLearningEnd(store, "waiting");
  assert.deepEqual([end.state, end.reason, end.detail], ["proposed", null, golden.proposed.detail]);
});
