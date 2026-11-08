// A run's end is its release (the store's rule: a write that makes the run final clears its runner and moves its epoch on),
// and a confirmed final outcome is always made durable before the runner says it released the run: the end, then a flush,
// then the release (a no-op on a final run), in that order, whatever came between. Two ways that order could break: a
// resume that fails on a run with a stop waiting (the runner ends it stopped itself, and the end's own write refused the
// other rows: nothing is taken after it), and a renew answered Fenced right after the loop's own end commit (expected,
// never a lost claim). Both are driven by the store's recorded calls, never by timing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
import { commandRow, fauxLoops, observed, queue, recorder, stores, until } from "./runner-support.mjs";

const TIMING = { leaseMs: 2_000, renewEveryMs: 40, stopMarginMs: 500, pollMs: 20, commandPollMs: 30, resumeTries: 3, resumeBackoffMs: 300 };

test("a parked run with a raise and a stop waiting, whose resume fails, ends stopped by its own write: the raise refused in that write, then a flush, then the release", async (t) => {
  const faux = fauxLoops({ park: true, turns: 2, turnMs: 10 });
  let failing = false;
  const createLoop = (deps) => {
    const loop = faux.createLoop(deps);
    const start = loop.start;
    loop.start = async (claim) => {
      if (failing && claim.from === "parked") throw new Error("the harness could not start");
      return start(claim);
    };
    return loop;
  };
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const events = [];
  const runner = startRunner({ store: observed(store, record), createLoop, name: "runner-a", ...TIMING, onEvent: (event) => events.push(event) });
  t.after(() => runner.close());
  await queue(server, "run-1");
  await until(async () => {
    const run = await server.runs.get("run-1");
    return run.state === "parked" && run.runner === null;
  }, "the run parks and is released");
  failing = true;
  const raise = await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 5 } });
  await sendCommand(server, "run-1", { kind: "stop" });
  // Precondition: the runner finished with the run, said released or failed in words (bounded).
  await until(() => events.some((event) => event.type === "released" && event.end === "stopped") || events.some((event) => event.type === "error"), "precondition: the runner is done with the run (released, or an error)");
  // The property, first: the end write (the raise refused in it), then a flush, then the release.
  assert.match(record.ops.join(" | "), /stopped run-1 \| flush \| release run-1/, `the end, then a flush, then the release: ${record.ops.join(" | ")}; events ${JSON.stringify(events.filter((event) => event.type !== "claimed"))}`);
  const row = await commandRow(server, "run-1", raise.id);
  assert.equal(row.refused, "the run was stopped before this command was taken", "the raise refused by the end's own write");
  assert.ok(events.some((event) => event.type === "refused" && event.commandId === raise.id), "and said refused");
  assert.deepEqual(events.filter((event) => event.type === "error"), [], "no error on the way");
});

test("a renew answered Fenced right after the loop's own end commit is no lost claim: the end is flushed and released before the runner says released", async (t) => {
  const faux = fauxLoops({ turns: 1, turnMs: 10 });
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const events = [];
  const createLoop = (deps) => {
    const loop = faux.createLoop(deps);
    const start = loop.start;
    loop.start = async (claim) => {
      const end = await start(claim);
      // Held until a renew after the end commit has been answered and the runner has acted on it: the end released the
      // run, so that renew is Fenced and the runner marks the claim lost. Only then does the loop come back with its end.
      await until(() => events.some((event) => event.type === "claim-lost" && event.why === "fenced"), "precondition: a renew after the end commit is answered Fenced (claim-lost)");
      return end;
    };
    return loop;
  };
  const runner = startRunner({ store: observed(store, record), createLoop, name: "runner-a", ...TIMING, onEvent: (event) => events.push(event) });
  t.after(() => runner.close());
  await queue(server, "run-1");
  await until(() => events.some((event) => event.type === "released"), "precondition: the runner says released");
  // The property: made durable before it is said released (the end, a flush, the release), whatever the renew said.
  assert.match(record.ops.join(" | "), /ended run-1 \| flush \| release run-1/, `the end, then a flush, then the release: ${record.ops.join(" | ")}`);
  const run = await server.runs.get("run-1");
  assert.deepEqual([run.state, run.runner], ["ended", null]);
});
