// A person's steer that reaches the loop as the run parks (its journal sealed on the ask) is left for the resume, never
// refused for good: the loop answers it `later`, its row stays untaken (it wakes the run), and the resume takes it.
// Driven with no timing: the steer is handed to the loop the moment its start() came back parked, its journal sealed then,
// before the runner releases the run. (Round 4 dropped an earlier version that waited on the clock.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { piSpec } from "./conformance-pi.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createPiLoop } = await import("../dist/runner/loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const TIMING = { leaseMs: 2_000, renewEveryMs: 150, stopMarginMs: 500, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

test("a steer handed to the loop as the run parks is answered later, left untaken, and taken by the resume, never refused", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const { tools } = suiteTools();
  const inner = createPiLoop(piSpec({ script: [{ call: "asked" }, { say: "done" }], tools, hooks: quiet }));
  /** The steer handed to the parked loop: its row id, the loop's answer, and its row as that answer left it. */
  let handed;
  const createLoop = (deps) => {
    const loop = inner(deps);
    return {
      ...loop,
      start: async (claim) => {
        const end = await loop.start(claim);
        if (end.state === "parked" && handed === undefined) {
          handed = {};
          const steer = await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "and check the weekend too" } });
          const row = (await opened.server.commands("run-1", steer.id - 1)).find((command) => command.id === steer.id);
          handed.id = steer.id;
          handed.outcome = await loop.command(row);
          handed.after = (await opened.server.commands("run-1", steer.id - 1)).find((command) => command.id === steer.id);
        }
        return end;
      },
    };
  };
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => handed?.after !== undefined, "precondition: the run parked and the steer was handed to its loop");
  assert.ok("later" in handed.outcome, `a steer that reaches a parking loop is left for later: ${JSON.stringify(handed.outcome)}`);
  assert.equal(handed.after.takenAt, null, "its row stays untaken");
  const row = await until(async () => {
    const now = (await opened.server.commands("run-1", handed.id - 1)).find((command) => command.id === handed.id);
    return now.takenAt !== null && now;
  }, "the steer row taken by the resume", 15_000);
  assert.equal(row.refused, null, `taken by the resume, never refused: ${JSON.stringify(row)}`);
});
