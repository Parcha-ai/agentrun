// pi through the adapter loop: an approval that reaches a claim's loop once its pass is over (the run parked, its Harness
// closed behind the journal's seal) is left for the run's next claim, never read through the closed Harness (#2292: it
// threw "Session is closed" out of the dispatch's replay). The park is driven directly: the loop the claim ran is kept and
// handed the answer after its run parked, with no wait on the clock. The answer then sent as a row resumes the run.
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

test("pi through the adapter: an approval handed to a claim's loop after its run parked is left for the next claim (later), not read through the closed Harness; the row then resumes the run", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const { tools, ran } = suiteTools();
  const factory = piAdapterSubject.createLoop({ script: [{ call: "asked" }, { say: "done" }], tools, hooks: quiet });
  const loops = [];
  const runner = startRunner({ store: opened.runners[0], createLoop: (deps) => (loops.push(factory(deps)), loops.at(-1)), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const parked = await until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === "parked" && row.runner === null && row;
  }, "the run parked on its ask");
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: parked.epoch, until: 0, from: parked.state }), BACKGROUND_CONTEXT);
  const callId = entries.find((entry) => entry.kind === "agentrun.ask").data.callId;
  assert.equal(loops.length, 1, "one claim so far");
  // The claim's loop, its pass over: the answer reaches it as the runner's delivery or the dispatch's replay would.
  const row = { id: 999, runId: "run-1", kind: "approve", body: { approval: callId }, createdAt: Date.now(), takenAt: null, refused: null, tries: 0 };
  const outcome = await loops[0].command(row);
  assert.ok("later" in outcome, `left for the next claim, never refused nor taken by a loop that is done: ${JSON.stringify(outcome)}`);
  assert.equal(ran.asked, 0, "the call still waits for its answer");
  // The answer as a row: the next claim takes it, and the call runs once.
  await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: callId } });
  await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended after its approval", 10_000);
  assert.equal(ran.asked, 1, "approved, it ran once");
});
