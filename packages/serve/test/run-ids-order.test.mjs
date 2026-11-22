// Runs started in one millisecond keep their order. A run's row takes its start time from the store's clock, so runs
// started in the same millisecond tie on started_at, and the list (started_at DESC, id DESC) and the claim (started_at,
// id) both break the tie by the run's id. Every run id comes from the one UUIDv7 minter (ids.ts), whose counter makes
// each id sort after the one minted before it: the list shows the newest first and a runner claims the oldest first. The
// clock is frozen with mock timers; nothing sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, startRun } from "./support.mjs";

const RUNS = 12;

test("runs started in one millisecond list newest first and are claimed oldest first, in the order they were started", { timeout: 120_000 }, async (t) => {
  // Date alone, frozen before the server opens its store (whose clock is Date.now as it finds it): its timers still run.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { api, store } = await serve(t, { runner: false });
  const started = [(await startRun(api, "tied", "Run 1.")).run_id];
  for (let i = 2; i <= RUNS; i += 1) {
    const run = await api("POST", "/agents/tied/runs", { input: { content: `Run ${i}.` } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    started.push(run.body.run_id);
  }
  const rows = await Promise.all(started.map((id) => store.runs.get(id)));
  assert.equal(new Set(rows.map((row) => row.startedAt)).size, 1, "every run started in one millisecond");

  const listed = (await api("GET", `/runs?agent_id=tied&limit=${RUNS}`)).body.runs.map((item) => item.run_id);
  assert.deepEqual(listed, [...started].reverse(), "the list shows the newest first");
  const claimed = (await store.runs.claimMany("runner-test", RUNS)).map((claim) => claim.runId);
  assert.deepEqual(claimed, started, "a runner claims them in the order they were started");
});
