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
const id = (i) => `run-${String(i).padStart(3, "0")}`;

test("310 runs on a runner of 300 loops: at most 300 held at once, every run ends and is released, lag bounded", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  // Each turn does a little synchronous work, as a harness parsing a model's reply would. A run lasts about 5 s, long
  // enough for the runner to claim its 300 while the first are still going: on a loaded box a claim beside the loops'
  // commits takes about 6 ms (a real run lasts minutes).
  const faux = fauxLoops({ turns: 5, turnMs: 1_000, work: () => JSON.parse(JSON.stringify({ text: "x".repeat(2_000) })) });
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
  const sampler = setInterval(() => (most = Math.max(most, runner.held().length)), 5);
  t.after(() => clearInterval(sampler));
  await until(async () => {
    const runs = await server.runs.list({ state: "ended" });
    return runs.length === RUNS && runs.every((run) => run.runner === null);
  }, "every run ends and is released", 60_000);
  lag.disable();
  await sleep(20);

  assert.ok(most <= LOOPS, `held ${most} at once (at most ${LOOPS})`);
  assert.ok(most >= LOOPS - 10, `held ${most} at once: the runner fills its loops`);
  assert.equal(faux.loops.length, RUNS, "one loop per run");
  assert.equal(record.claims.length, RUNS, "each run claimed once");
  const p99 = lag.percentile(99) / 1e6;
  assert.ok(p99 < LAG_P99_MS, `event-loop lag p99 ${p99.toFixed(1)} ms (bound ${LAG_P99_MS})`);
});
