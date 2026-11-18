// What learning changed for an agent, on GET /v2/agents/{id}/learning: `impact`, its completed runs before its first
// learned item (its first merge: here an owner's correction) against its completed runs that started from at least one
// (a line of corrections.md, or a learned workflow their claims laid). Each side: how many runs, their median time to the
// answer (the run's start to its job's answer), the median of the job's own cost over the `cost_runs` whose cost is
// known (what learning itself cost is the bill's, GET /v2/agents/{id}/learning/cost). Null until both sides count 2. A run with learning off, or one seeded with nothing (its corrections cleared), is on neither side.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ended, fedBack, LEARN, learner, made, started } from "./learn-support.mjs";
import { serve, storeRun } from "./support.mjs";

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/** Run `runId` as its store row and its first round's learning end give it: its time to the answer, its job's own cost
 *  and what its learning cost (all its row spent after the job answered). It answered before its row ended, and its
 *  job's cost and its learning's add up to its row's cost. */
async function figuresOf(store, data, runId) {
  const row = storeRun(data, runId);
  const first = (await store.learning.proposal(runId, 1))?.proposal;
  assert.ok(first, `run ${runId} kept its first round's learning`);
  assert.ok(Date.parse(first.answered_at) <= Date.parse(row.endedAt), "it answered before its run ended");
  assert.ok(first.job_cost_usd > 0, JSON.stringify(first));
  const learning = Math.round((row.costUsd - first.job_cost_usd) * 1e9) / 1e9;
  assert.ok(learning >= 0, "the job and its learning are the run's cost");
  return { duration: (Date.parse(first.answered_at) - Date.parse(row.startedAt)) / 1000, cost: first.job_cost_usd, learning };
}
/** A side of `impact` as the runs `runIds` give it. */
async function sideOf(store, data, runIds) {
  const runs = await Promise.all(runIds.map((runId) => figuresOf(store, data, runId)));
  return {
    runs: runs.length,
    median_duration_s: Math.round(median(runs.map((run) => run.duration)) * 10) / 10,
    median_cost_usd: Math.round(median(runs.map((run) => run.cost)) * 1e6) / 1e6,
    cost_runs: runs.length,
  };
}

test("an agent's impact: null before any correction and until each side counts 2 runs; then before its first correction against runs seeded with one, each side's time to the answer, its job's own cost and what learning cost, from the store's rows and each run's learning; a run with learning off and one seeded with nothing are on neither side; a restarted server, which holds none of the runs, reads the same from the store", { timeout: 240_000 }, async (t) => {
  const first = await serve(t, { learning: "on", faux: LEARN });
  let { api } = first;
  const { data, store } = first;
  const id = "impact";
  const impact = async () => (await api("GET", `/agents/${id}/learning`)).body.impact;
  const define = async (extra) => {
    const { id: _, version: __, ...definition } = learner(id, extra).definition;
    assert.equal((await api("PUT", `/agents/${id}/definition`, { definition })).status, 200);
  };
  const runOnce = async () => (await ended(api, await started(api, id))).view;
  assert.equal((await api("GET", "/agents/nobody/learning")).status, 404);
  await made(api, learner(id));
  assert.equal(await impact(), null, "no folder yet");

  // Two runs that learn nothing, then one its owner corrects, the agent's first learned item: all three started before it.
  const before = [(await runOnce()).run_id, (await runOnce()).run_id];
  assert.equal(await impact(), null, "a folder, and nothing learned in it");
  const corrected = (await fedBack(api, id)).view;
  assert.equal(corrected.learning.state, "merged", JSON.stringify(corrected.learning));
  before.push(corrected.run_id);
  assert.equal(await impact(), null, "no run started from the correction yet");

  // Runs seeded with the correction: one is not enough.
  const after = [(await runOnce()).run_id];
  assert.equal(await impact(), null, "one run after");
  // A run with learning off started from nothing: on neither side.
  await define({ learning: false });
  assert.equal((await runOnce()).learning, null);
  await define({});
  after.push((await runOnce()).run_id);
  const both = await impact();
  assert.deepEqual(both, { before: await sideOf(store, data, before), after: await sideOf(store, data, after) });
  assert.deepEqual([both.before.runs, both.after.runs, both.before.cost_runs, both.after.cost_runs], [3, 2, 3, 2]);
  assert.ok(both.before.median_cost_usd > 0 && both.after.median_cost_usd > 0, JSON.stringify(both));
  assert.ok(!("median_learning_usd" in both.after), "what learning cost is the bill's (cost.bill.learning_usd), never a second median here");

  // The corrections cleared: a run seeded from nothing is on neither side.
  const read = await api("GET", `/agents/${id}/learning/corrections`);
  assert.equal((await api("PUT", `/agents/${id}/learning/corrections`, { text: "" }, { "if-match": read.headers.get("etag") })).status, 200);
  assert.equal((await runOnce()).learning.state, "dropped");
  assert.deepEqual(await impact(), both, "the run seeded with nothing counts on neither side");

  // A server started again holds none of these runs: each run's corrections at its start (its launch), its answer's time
  // and its costs (its learning end) come from the store.
  await first.close();
  ({ api } = await serve(t, { learning: "on", faux: LEARN, data }));
  assert.deepEqual(await impact(), both, "the same, from the store");
});
