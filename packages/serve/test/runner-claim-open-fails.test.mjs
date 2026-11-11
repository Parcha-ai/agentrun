// A run whose new claim fails to open (its harness's session throws at open) fails in words, and the runner process holding
// it goes on: no unhandled rejection (Node's default ends the process, and with it every run it holds), and the runner
// still claims and runs the next run. The rows a person sent before the claim (a message, an approval) reach the runner's
// dispatch before its inner loop is chosen, are buffered there, and are replayed through a loop whose pass is already over
// (#2200: the replay read the closed Harness and threw "Session is closed" out of a fire-and-forget promise). The inner loop
// is chosen only once those rows were handed over, so the ordering is read from the dispatch, never from the clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const OPEN_FAILED = "the harness's CLI could not start";

/** A stand-in harness adapter: its session answers each turn at once, or, `failsToOpen`, its open throws. */
function standIn({ failsToOpen = false } = {}) {
  return {
    id: "stand-in",
    capabilities: () => ({}),
    check: () => [],
    async open(_spec, io) {
      if (failsToOpen) throw new Error(OPEN_FAILED);
      let state = "new";
      let turn;
      return {
        get state() { return state; },
        async send() {
          state = "idle";
          turn = (async () => {
            io.onEvent({ type: "text", delta: "Done." });
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() {},
      };
    },
  };
}

const adapterLoopOn = (adapter) => createAdapterLoop(() => ({
  adapter,
  session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
  input: "Do it.",
  runCap: { capUsd: () => undefined, modelOf: () => undefined },
  record: "loop",
  hooks: quiet,
  gate: () => "allow",
}));

test("a run whose claim fails to open fails in words; the rows buffered for it leave no unhandled rejection, and the runner goes on to claim and run the next run", async (t) => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  // A person's message and an approval, sent before any claim: the runner hands both to the claim's dispatch at once.
  await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "Also check the other one." } });
  await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: "call-1" } });
  // run-1's launch is read only once both rows were handed to its dispatch, so both are buffered before its inner loop
  // (whose session fails to open) is chosen.
  let handed = 0;
  let bothHanded;
  const buffered = new Promise((resolve) => (bothHanded = resolve));
  const dispatch = createDispatchLoop({
    launchOf: async (runId) => {
      if (runId === "run-1") await buffered;
      return { body: { place: { mode: "runner" }, harness: "stand-in" } };
    },
    resolve: (_harness, _launch, runId) => adapterLoopOn(standIn({ failsToOpen: runId === "run-1" })),
  });
  const createLoop = (deps) => {
    const loop = dispatch(deps);
    return {
      ...loop,
      async command(command) {
        const outcome = await loop.command(command);
        if (++handed === 2) bothHanded();
        return outcome;
      },
    };
  };
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const failed = await until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === "failed" && row.runner === null && row;
  }, "run-1 failed and was released", 10_000);
  assert.match(failed.summary ?? "", /could not start/, `it says why: ${JSON.stringify(failed.summary)}`);
  // The runner is still up and claiming: the next run is claimed, runs and ends.
  await queue(opened.server, "run-2");
  await until(async () => {
    const row = await opened.server.runs.get("run-2");
    return row.state === "ended" && row.runner === null && row;
  }, "run-2 ended on the same runner", 10_000);
  // Every promise the failed claim left has settled by now (its replay ran before run-2 was claimed): none was left
  // unhandled.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rejections.map((reason) => String(reason?.stack ?? reason)), [], "no unhandled rejection");
  assert.equal(handed >= 2, true, "both rows reached the dispatch before its inner loop was chosen");
});
