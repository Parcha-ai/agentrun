// GET /stats while a run's end waits for the agent store: the run reads ended (GET /runs/{id}) before its end, with its
// metrics, is in the store. Its counts are what the server holds; its metrics are left out until the store has them,
// and then it counts whole. It is never counted running, its status unknown, or its cost unknown.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, scratch, serve } from "./support.mjs";

/** A faux model whose output is priced, so the run's cost is known once its end is in the store. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;

/** Another connection holding store.sqlite as a writer: the run's end waits, readers still read. */
function hold(t, data) {
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  store.exec("BEGIN IMMEDIATE");
  const release = () => store.isOpen && (store.isTransaction && store.exec("ROLLBACK"), store.close());
  t.after(release);
  return release;
}

test("GET /stats while a completed run's end waits for the agent store: counted completed, not running, its cost never unknown; whole once the store has its end", async (t) => {
  const dir = await scratch(t);
  let firstBusy;
  const busy = new Promise((resolve) => (firstBusy = resolve));
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED, carryBackRetry: { delaysMs: Array(40).fill(50), onBusy: () => firstBusy() }, settleRetryMs: 300 });
  assert.equal((await api("POST", "/agents", agent("ender", { instructions: `Answer once ${join(dir, "go")} exists.` }))).status, 201);
  const started = await api("POST", "/agents/ender/runs", { input: { content: "hi" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const release = hold(t, data);
  await writeFile(join(dir, "go"), "");
  await busy;
  // The window: the server holds the run as ended, and the store still has it running.
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run));
  const during = (await api("GET", "/stats?agent=ender")).body;
  release();
  await follow(api, runId, ["completed", "failed"]);
  let after;
  for (let i = 0; i < 100; i++) {
    after = (await api("GET", "/stats?agent=ender")).body;
    if (after.analytics.totals.runs_with_metrics === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Once the store has its end, the run counts whole: completed, with its tokens and a known cost.
  assert.deepEqual([after.analytics.totals.runs, after.analytics.totals.completed, after.analytics.totals.runs_with_metrics, after.analytics.totals.unknown_cost_runs, after.cost.unknown_runs, after.runs.status_unknown], [1, 1, 1, 0, 0, 0], JSON.stringify(after));
  assert.ok(after.analytics.totals.tokens > 0, JSON.stringify(after.analytics.totals));
  assert.equal(typeof after.analytics.totals.cost_usd, "number", JSON.stringify(after.analytics.totals));
  assert.ok(after.analytics.by_harness_effort.every((g) => g.effort !== null), JSON.stringify(after.analytics.by_harness_effort));
  // While its end waited: the same counts, completed; nothing counted running or unknown; no metrics yet.
  const window = (stats) => ({
    total: stats.runs.total,
    analytics_runs: stats.analytics.totals.runs,
    completed: stats.analytics.totals.completed,
    status_unknown: stats.runs.status_unknown,
    unknown_cost_runs: stats.analytics.totals.unknown_cost_runs,
    cost_unknown_runs: stats.cost.unknown_runs,
    unknown_effort_groups: stats.analytics.by_harness_effort.filter((g) => g.effort === null).length,
  });
  assert.deepEqual(window(during), { ...window(after), completed: 1 }, `while the end waited: ${JSON.stringify({ runs: during.runs, cost: during.cost, totals: during.analytics.totals })}`);
});
