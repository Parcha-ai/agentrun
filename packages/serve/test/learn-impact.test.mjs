// What learning changed for an agent, on GET /v2/agents/{id}/learning: `impact`, its completed runs before its first
// note (a run's merge or a person's) against its completed runs that started from at least one active note. Each side:
// how many runs, their median time to the answer (the run's start to its job's end, before it looks back), the median
// of the job's own cost (its look-back set apart) over the `cost_runs` whose cost is known, and the median of what
// learning itself cost a run (its look-back and its grade). Null until both sides count 2. A run with learning off, or
// one seeded with no note (every note retired), is on neither side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learner, made, savedOf, started } from "./learn-support.mjs";
import { serve, storeRun } from "./support.mjs";

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/** Run `runId` as its store row and its serve.json give it: its time to the answer, its job's own cost, and what its
 *  learning cost (none for a run with learning off). A run that looked back answered before its row ended, and its
 *  job's cost and its look-back's add up to its row's cost. */
function figuresOf(data, runId) {
  const row = storeRun(data, runId);
  const { learning } = JSON.parse(readFileSync(join(data, "runs", runId, "serve.json"), "utf8"));
  const started = Date.parse(row.startedAt);
  if (!learning) return { duration: (Date.parse(row.endedAt) - started) / 1000, cost: row.costUsd };
  assert.ok(Date.parse(learning.answered_at) < Date.parse(row.endedAt), "it answered before it looked back");
  assert.ok(learning.job_cost_usd > 0 && learning.look_back_usd > 0, JSON.stringify(learning));
  assert.ok(Math.abs(learning.job_cost_usd + learning.look_back_usd - row.costUsd) < 1e-9, "the job and the look-back are the run's cost");
  return { duration: (Date.parse(learning.answered_at) - started) / 1000, cost: learning.job_cost_usd, learning: learning.look_back_usd + (learning.cost_usd?.grade ?? 0) };
}
/** A side of `impact` as the runs `runIds` give it. */
function sideOf(data, runIds) {
  const runs = runIds.map((runId) => figuresOf(data, runId));
  return {
    runs: runs.length,
    median_duration_s: Math.round(median(runs.map((run) => run.duration)) * 10) / 10,
    median_cost_usd: Math.round(median(runs.map((run) => run.cost)) * 1e6) / 1e6,
    cost_runs: runs.length,
    median_learning_usd: Math.round(median(runs.map((run) => run.learning)) * 1e6) / 1e6,
  };
}

test("an agent's impact: null before any note and until each side counts 2 runs; then before its first note against runs seeded with one, each side's time to the answer, its job's own cost and what learning cost, from the store's rows and each run's learning; a run with learning off and one seeded with no note are on neither side; a restarted server, which holds none of the runs, reads the same from the learning ledger", { timeout: 240_000 }, async (t) => {
  const first = await serve(t, { learning: "on", faux: LEARN });
  let { api } = first;
  const { data } = first;
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

  // Two runs that learn nothing, then one that learns the agent's first note: all three started before it.
  const before = [(await runOnce()).run_id, (await runOnce()).run_id];
  assert.equal(await impact(), null, "a folder, and no note in it");
  await define({ plan: [["check-units.md", UNITS]], once: true });
  const firstNote = await runOnce();
  assert.equal(firstNote.learning.state, "merged");
  before.push(firstNote.run_id);
  assert.equal(await impact(), null, "no run started from the note yet");

  // Runs seeded with the note: one is not enough.
  const after = [(await runOnce()).run_id];
  assert.equal(await impact(), null, "one run after");
  // A run with learning off started from nothing: on neither side.
  await define({ learning: false });
  assert.equal((await runOnce()).learning, null);
  await define({ plan: [["check-units.md", UNITS]], once: true });
  after.push((await runOnce()).run_id);
  const both = await impact();
  assert.deepEqual(both, { before: sideOf(data, before), after: sideOf(data, after) });
  assert.deepEqual([both.before.runs, both.after.runs, both.before.cost_runs, both.after.cost_runs], [3, 2, 3, 2]);
  assert.ok(both.before.median_cost_usd > 0 && both.after.median_learning_usd > 0, JSON.stringify(both));

  // Every note retired: a run seeded from none is on neither side.
  const file = await api("GET", `/agents/${id}/learning/files/check-units.md`);
  assert.equal((await api("POST", `/agents/${id}/learning/files/check-units.md/retire`, undefined, { "if-match": file.headers.get("etag") })).status, 200);
  await define({});
  assert.equal((await runOnce()).learning.state, "dropped");
  assert.deepEqual(await impact(), both, "the run seeded with no note counts on neither side");

  // A server started again holds none of these runs: each run's notes at its start, its answer's time and its costs
  // come from its ledger line.
  for (const runId of [...before, ...after]) await savedOf(data, runId);
  await first.close();
  ({ api } = await serve(t, { learning: "on", faux: LEARN, data }));
  assert.deepEqual(await impact(), both, "the same, from the ledger");
});
