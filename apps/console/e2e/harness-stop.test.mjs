// The e2e harness's stop (harness.mjs startServer's stop) with a run still in its turn: the server drains the run for its
// --drain-timeout and exits, inside the harness's own stop bound (STOP_MS), never SIGKILLed. The server's own default
// drain (30 s, beside.ts DRAIN_TIMEOUT) is longer than that bound, so the harness passes a drain of its own; without it
// every flow that ends with a run in its turn had its server killed (run.mjs's KILLED lines). Needs the repository built
// (npm run build) at AGENTRUN_E2E_CHECKOUT, or this checkout without it. run.mjs runs it before the flows, on its checkout
// target (`npm run test:e2e`, CI's console-e2e job), or run it alone with `node --test apps/console/e2e/harness-stop.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiOf, DRAIN_MS, startServer, STOP_MS } from "./harness.mjs";

test("the harness stops a server whose run is still in its turn with a drain, not SIGKILL", { timeout: STOP_MS * 4 }, async (t) => {
  const server = await startServer(process.env.AGENTRUN_E2E_CHECKOUT ? { checkout: process.env.AGENTRUN_E2E_CHECKOUT } : {});
  let stopped;
  try {
    const api = apiOf(server);
    const made = await api("POST", "/agents", { definition: { id: "slow", name: "Slow", instructions: "Work.", tools: [], skills: [] } });
    assert.equal(made.status, 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);
    // The faux model answers "Take your time" a minute later, or at once aborted when the turn is stopped.
    const started = await api("POST", "/agents/slow/runs", { input: { content: "Take your time." } });
    assert.equal(started.status, 202, `starting the run answered ${started.status}`);
    const runId = started.body.run_id;
    // The run is in its turn once the server reads it working.
    for (const end = Date.now() + 30_000; ; ) {
      const read = await api("GET", `/runs/${encodeURIComponent(runId)}`);
      if (read.body?.status === "working") break;
      assert.ok(Date.now() < end, `the run never read working: ${JSON.stringify(read.body)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    const began = Date.now();
    stopped = await server.stop();
    stopped.ms = Date.now() - began;
  }
  // The stop found the run in its turn and drained it (cli.ts says so as it begins).
  assert.match(server.log(), /waiting up to \d+ s for 1 run to finish its turn/);
  assert.equal(stopped.killed, false, `the server was still running ${STOP_MS} ms after SIGTERM and was killed (took ${stopped.ms} ms)`);
  t.diagnostic(`stopped in ${stopped.ms} ms, drain ${DRAIN_MS} ms, bound ${STOP_MS} ms`);
  assert.ok(stopped.ms < STOP_MS, `the stop took ${stopped.ms} ms, under the harness's bound of ${STOP_MS} ms`);
});
