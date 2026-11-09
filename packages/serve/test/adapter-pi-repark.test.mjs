// pi through the adapter loop: a run parked on an asked call and brought back by a row that does not answer it (a
// person's steer) parks again once the claim's first delivery is done and no answer for that call came; it never waits
// in the loop holding the claim while it reads running. Its own approval then answers it. The adapter loop's twin of
// runner-loop-repark.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

test("pi through the adapter: a parked run woken by a steer, with no answer for its asked call, parks again; its approval then answers it", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const { tools, ran } = suiteTools();
  const runner = startRunner({ store: opened.runners[0], createLoop: piAdapterSubject.createLoop({ script: [{ call: "asked" }, { say: "done" }], tools, hooks: quiet }), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const parkedAt = async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === "parked" && row.runner === null && row;
  };
  const first = await until(parkedAt, "the run parked on its ask");
  await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "any news?" } });
  const again = await until(async () => {
    const row = await parkedAt();
    return row && row.epoch > first.epoch && row;
  }, "the run parked again after the steer woke it", 10_000).catch(async (error) => {
    throw new Error(`${error.message}: the run is ${JSON.stringify(await opened.server.runs.get("run-1"))}`);
  });
  assert.ok(again.epoch > first.epoch, "it was claimed again by the steer, then released parked");
  assert.equal(ran.asked, 0, "the call waits for its answer");
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: again.epoch, until: 0, from: again.state }), BACKGROUND_CONTEXT);
  const callId = entries.find((entry) => entry.kind === "agentrun.ask").data.callId;
  await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: callId } });
  await until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === "ended" && row.runner === null && row;
  }, "the run ended after its approval", 10_000);
  assert.equal(ran.asked, 1, "approved, it ran once");
});
