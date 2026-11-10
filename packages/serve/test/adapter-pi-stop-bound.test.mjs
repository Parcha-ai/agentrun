// pi through the adapter loop: a person's stop has a bound (the adapter loop's twin of runner-loop-stop-bound). When a
// tool call ignores its abort, the loop waits for the turn to settle at most the stop's bound (AdapterRunSpec
// stopSettleMs), then ends the run failed in words, the stop row taken in that end's commit.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

test("pi through the adapter: a stop whose tool call ignores its abort ends the run failed in words within the stop's bound, the stop row taken", async (t) => {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  let started = () => {};
  const running = new Promise((resolve) => (started = resolve));
  let letGo = () => {};
  const held = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  // Ignores its signal: only the test lets it go.
  const tools = { stubborn: { name: "stubborn", replaySafe: true, ask: false, run: async () => (started(), await held, "late") } };
  const spec = piAdapterSpec({ script: [{ call: "stubborn" }, { say: "done" }], tools, hooks: quiet });
  const createLoop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), stopSettleMs: 300 }));
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await running;
  const stop = await sendCommand(opened.server, "run-1", { kind: "stop" });
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return ["failed", "stopped", "ended"].includes(now.state) && now.runner === null && now;
  }, "the run's end within the stop's bound", 5_000).catch(async (error) => {
    throw new Error(`${error.message}: the run is ${JSON.stringify(await opened.server.runs.get("run-1"))}`);
  });
  assert.equal(row.state, "failed", `failed, the stop did not settle: ${JSON.stringify(row)}`);
  assert.match(row.summary ?? "", /stop/i, `in words: ${row.summary}`);
  const stopRow = (await opened.server.commands("run-1", stop.id - 1)).find((command) => command.id === stop.id);
  assert.notEqual(stopRow.takenAt, null, "the stop row is taken");
  assert.equal(stopRow.refused, null, "taken, not refused");
});
