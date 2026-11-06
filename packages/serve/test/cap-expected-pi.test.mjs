// Expected-cost admission on pi, end to end: a run whose requests read the cache, as Claude Sonnet 5.5 reports them
// (faux-sonnet-cache.mjs), until one finds no cache once $0.44 is billed. That request was admitted at its expected cost,
// so it passes the $0.50 cap: its real cost is booked, never clipped, by no more than the bound its start mark carries,
// one row says so in cents, and the run is not failed: its next request is refused and it pauses at its cap.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { agent, follow, letGo, serve } from "./support.mjs";

const CACHE = new URL("./fixtures/faux-sonnet-cache.mjs", import.meta.url).pathname;
/** An amount in a row's words: up to the cent above. */
const centsUp = (usd) => `$${(Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2)}`;

test("pi: a cache miss passes the cap by no more than the bound it was sent with; its real cost is booked, one row says so in cents, the run pauses at its cap, and a server started again says the same", { timeout: 240_000 }, async (t) => {
  // The run's data outlives its first server: a second one reads it whole, as after a restart.
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "cap-expected-pi-"));
  const data = join(dir, "agents");
  let stopFirst;
  const { api } = await serve({ after: (stop) => void (stopFirst = stop) }, { faux: CACHE, data });
  assert.equal((await api("POST", "/agents", agent("pi-miss", { instructions: "Write the pages.", tools: ["write"] }))).status, 201);
  const started = await api("POST", "/agents/pi-miss/runs", { input: { content: "go" }, max_cost_usd: 0.5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 150_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.pending?.kind, run.error], ["input_required", "budget", null], JSON.stringify(run.error));
  const over = run.cost.usd - 0.5;
  assert.ok(over > 0, `the miss passed the cap: $${run.cost.usd}`);
  assert.equal(run.cost.overshoot_bound_usd, 0, "no request in flight");
  await letGo(data, runId);
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  const starts = db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === REQUEST_STARTED && entry.data?.capRefused !== true);
  db.close();
  // The miss is the last request sent: its bound, on its start mark.
  const bound = starts.at(-1)?.data?.boundUsd;
  assert.ok(bound > 0 && over <= bound + 1e-9, `over by $${over}, its bound $${bound}`);
  const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows.filter((row) => row.id.endsWith(":over_cap"));
  const words = `Went ${centsUp(over)} over its cap on a cache miss (at most ${centsUp(bound)}).`;
  assert.deepEqual(rows.map((row) => row.summary), [words]);
  // A server started again reads the run's store whole: its row names the same bound, never every bound the run had.
  await stopFirst();
  const again = await serve(t, { faux: CACHE, data });
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const reread = (await again.api("GET", `/runs/${runId}/timeline`)).body.rows.filter((row) => row.id.endsWith(":over_cap"));
  assert.deepEqual(reread.map((row) => row.summary), [words], "after a restart");
  const view = (await again.api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.status, view.pending?.kind, view.cost.overshoot_bound_usd], ["input_required", "budget", 0], "still paused, nothing in flight");
});
