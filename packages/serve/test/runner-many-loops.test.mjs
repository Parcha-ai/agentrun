// One runner carries many loops (design: "about 300 loops per Node process"): 310 queued runs, a runner of 300 loops, on
// the store's one connection (its worker thread). It never holds more than 300 at once, every run ends and is released,
// and the event loop's lag stays bounded while they run (the runner's timers and polls are shared, never one busy loop
// per run, and the store's writes are off the main thread).
import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const RUNS = 310;
const LOOPS = 300;
// Generous for a loaded box: a runner that serialises its loops, or spins, is seconds behind.
const LAG_P99_MS = 250;
// Time from the runner's start to 300 held: one batch claim, then 300 loops opened. Claimed one by one (~6 ms each on a
// loaded box beside the loops' commits) it is about 1.8 s.
const FILL_MS = 1_000;
const id = (i) => `run-${String(i).padStart(3, "0")}`;

test("310 runs on a runner of 300 loops: at most 300 held at once, every run ends and is released, lag bounded", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  // Each turn does a little synchronous work, as a harness parsing a model's reply would. Runs of about 250 ms: the
  // runner fills its 300 loops in one batch claim (store.runs.claimMany), long before the first run ends.
  const faux = fauxLoops({ turns: 5, turnMs: 50, work: () => JSON.parse(JSON.stringify({ text: "x".repeat(2_000) })) });
  for (let i = 0; i < RUNS; i++) await queue(server, id(i));

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const runner = startRunner({
    store: observed(store, record),
    createLoop: faux.createLoop,
    name: "runner-a",
    loops: LOOPS,
    leaseMs: 10_000,
    renewEveryMs: 2_000,
    stopMarginMs: 2_000,
    pollMs: 20,
    commandPollMs: 200,
  });
  t.after(() => runner.close());

  let most = 0;
  let full;
  const startedAt = Date.now();
  const sampler = setInterval(() => {
    most = Math.max(most, runner.held().length);
    if (full === undefined && most >= LOOPS) full = Date.now() - startedAt;
  }, 5);
  t.after(() => clearInterval(sampler));
  await until(async () => {
    const runs = await server.runs.list({ state: "ended" });
    return runs.length === RUNS && runs.every((run) => run.runner === null);
  }, "every run ends and is released", 60_000);
  lag.disable();
  await sleep(20);

  assert.ok(most <= LOOPS, `held ${most} at once (at most ${LOOPS})`);
  assert.equal(record.batches[0], LOOPS, `the first claim is one batch of ${LOOPS}: ${JSON.stringify(record.batches)}`);
  assert.ok(full !== undefined && full < FILL_MS, `the runner held all ${LOOPS} within ${full} ms (bound ${FILL_MS})`);
  assert.equal(faux.loops.length, RUNS, "one loop per run");
  assert.equal(record.claims.length, RUNS, "each run claimed once");
  const p99 = lag.percentile(99) / 1e6;
  assert.ok(p99 < LAG_P99_MS, `event-loop lag p99 ${p99.toFixed(1)} ms (bound ${LAG_P99_MS})`);
});
