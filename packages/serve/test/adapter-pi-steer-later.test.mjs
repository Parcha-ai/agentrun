// pi through the adapter loop: a person's steer that reaches the loop as the run parks (its journal sealed on the ask) is
// left for the resume, not refused for good: answered `later`, the row stays untaken, it wakes the run, and the resume
// takes it. Made certain: the steer's first delivery is held until the runner says the run is released parked (its
// "released" event, after the park's flush and release), so the loop's journal is sealed when the steer arrives, whatever
// the machine's load: no poll and no wait on a clock. A person's message is never lost at a park, so this case is kept.
// The adapter loop's twin of runner-loop-steer-later.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
// One runner that never loses its claim (it parks and resumes the run itself): a lease no stall of a loaded machine runs
// out, so the steer's row is answered by this run's own park and resume, never by a takeover.
// endWaitMs: how long the park's end waits for the steer's held delivery before it writes (and drops that delivery's answer).
// Only a bound, so short: the steer's row is answered by the park and the resume whatever the wait.
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30, endWaitMs: 1 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

test("pi through the adapter: a steer that reaches the loop as the run parks is taken by the resume, never refused", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const { tools } = suiteTools();
  const inner = piAdapterSubject.createLoop({ script: [{ call: "asked" }, { say: "done" }], tools, hooks: quiet });
  let held = false;
  let parkedNow = () => {};
  const parked = new Promise((resolve) => (parkedNow = resolve));
  const onEvent = (event) => {
    if (event.type === "released" && event.runId === "run-1" && event.end === "parked") parkedNow();
  };
  const createLoop = (deps) => {
    const loop = inner(deps);
    return {
      ...loop,
      // The first steer is handed over only once the run is released parked: the loop's journal is sealed by then.
      command: async (command) => {
        if (command.kind === "steer" && !held) {
          held = true;
          await parked;
        }
        return loop.command(command);
      },
    };
  };
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", onEvent, ...TIMING });
  t.after(() => runner.close());
  await until(async () => (await opened.server.runs.get("run-1")).state === "running", "the run claimed");
  const steer = await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "and check the weekend too" } });
  const row = await until(async () => {
    const now = (await opened.server.commands("run-1", steer.id - 1)).find((command) => command.id === steer.id);
    return now.takenAt !== null && now;
  }, "the steer row answered", 15_000).catch(async (error) => {
    const now = (await opened.server.commands("run-1", steer.id - 1)).find((command) => command.id === steer.id);
    throw new Error(`${error.message}: the steer row is ${JSON.stringify(now)}, the run ${JSON.stringify(await opened.server.runs.get("run-1"))}`);
  });
  assert.equal(held, true, "the steer's first delivery was held until the run parked");
  assert.equal(row.refused, null, `the steer was taken by the resume, not refused: ${JSON.stringify(row)}`);
});
