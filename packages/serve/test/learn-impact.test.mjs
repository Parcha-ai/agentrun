// What learning changed for an agent, on GET /v2/agents/{id}/learning: `impact`, its completed runs before its first
// note (a run's merge or a person's) against its completed runs that started from at least one active note, each side's
// median run time and cost, as the store's run rows hold them, and how many runs each counts. Null until both sides
// count 2. A run with learning off, or one seeded with no note (every note retired), is on neither side.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learner, made, started } from "./learn-support.mjs";
import { serve, storeRun } from "./support.mjs";

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/** A side of `impact` as the store's rows of `runIds` give it. */
function sideOf(data, runIds) {
  const rows = runIds.map((runId) => storeRun(data, runId));
  return {
    runs: rows.length,
    median_duration_s: Math.round(median(rows.map((row) => (Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000)) * 10) / 10,
    median_cost_usd: Math.round(median(rows.map((row) => row.costUsd)) * 1e6) / 1e6,
  };
}

test("an agent's impact: null before any note and until each side counts 2 runs; then before its first note against runs seeded with one, each median from the store's rows; a run with learning off and one seeded with no note are on neither side; a restarted server, which holds none of the runs, reads the same from the learning ledger", { timeout: 240_000 }, async (t) => {
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
  assert.deepEqual([both.before.runs, both.after.runs], [3, 2]);
  assert.ok(both.before.median_cost_usd > 0 && both.after.median_duration_s >= 0, JSON.stringify(both));

  // Every note retired: a run seeded from none is on neither side.
  const file = await api("GET", `/agents/${id}/learning/files/check-units.md`);
  assert.equal((await api("POST", `/agents/${id}/learning/files/check-units.md/retire`, undefined, { "if-match": file.headers.get("etag") })).status, 200);
  await define({});
  assert.equal((await runOnce()).learning.state, "dropped");
  assert.deepEqual(await impact(), both, "the run seeded with no note counts on neither side");

  // A server started again holds none of these runs: each run's notes at its start come from its ledger line.
  await first.close();
  ({ api } = await serve(t, { learning: "on", faux: LEARN, data }));
  assert.deepEqual(await impact(), both, "the same, from the ledger");
});
