// The runner's part of a run paused at its cap (B3's R rows; each test names the serve red it is the twin of). A run
// paused at its cap parks: its loop ends, its claim is released, and no runner holds it until a raise row lands. A raise
// row written while no runner is up waits in the store and is taken once by the next runner's loop. Two raises at once
// bring the run back once. A run brought back by a raise is claimed before runs queued after it, when the runner's loops
// are full.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
import { commandRow, fauxLoops, observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const TIMING = { leaseMs: 2_000, renewEveryMs: 500, stopMarginMs: 500, pollMs: 20, commandPollMs: 30 };
const RAISE = { kind: "raise", body: { capUsd: 5 } };

const parkedAndReleased = (server, id) =>
  until(async () => {
    const run = await server.runs.get(id);
    return run.state === "parked" && run.runner === null;
  }, `${id} parked and released`);

// Twin of cap-pause "a run paused at its cap lets its process go, takes no message (409 budget_reached) until its cap is
// raised, and a server started again reads it paused": the runner's part (the 409 is the server's).
test("a run paused at its cap holds no runner: released parked, not claimed again until a raise row lands", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const faux = fauxLoops({ park: true, turns: 2, turnMs: 10 });
  const runner = startRunner({ store: observed(store, record), createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await queue(server, "run-1");

  await parkedAndReleased(server, "run-1");
  assert.deepEqual(runner.held(), [], "no loop holds it");
  await sleep(TIMING.pollMs * 10);
  assert.equal(record.claims.length, 1, "not claimed again with nothing to wake it");
  const raise = await sendCommand(server, "run-1", RAISE);
  await until(async () => (await server.runs.get("run-1")).state === "ended", "the raised run goes on and ends");
  assert.deepEqual(faux.loops[1].received.map((command) => command.id), [raise.id]);
});

// Twins of cap-raise "a server started again raises a paused run's cap the same: the run goes on under it and completes"
// and "a raise taken, then the server killed before its follow-up went: the next server sends it, once, and the run
// completes; the same raise again changes nothing".
test("a raise written while no runner is up waits in the store; the next runner's loop takes it once, and the run completes", async (t) => {
  const { server, runners: [first, second] } = await stores({ runners: 2 });
  const record = recorder();
  const faux = fauxLoops({ park: true, turns: 2, turnMs: 10 });
  const before = startRunner({ store: observed(first, record), createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  await queue(server, "run-1");
  await parkedAndReleased(server, "run-1");
  await before.close();

  const raise = await sendCommand(server, "run-1", RAISE);
  await sleep(TIMING.pollMs * 5);
  assert.equal((await commandRow(server, "run-1", raise.id)).takenAt, null, "with no runner up, the raise waits untaken");

  const after = startRunner({ store: observed(second, record), createLoop: faux.createLoop, name: "runner-b", ...TIMING });
  t.after(() => after.close());
  await until(async () => (await server.runs.get("run-1")).state === "ended", "the next runner's loop completes the run");
  assert.deepEqual([record.claims.at(-1).runner, record.claims.at(-1).epoch], ["runner-b", 2]);
  assert.deepEqual(faux.loops.flatMap((loop) => loop.received.map((command) => command.id)), [raise.id], "the raise reached one loop, once");
  assert.ok((await commandRow(server, "run-1", raise.id)).takenAt !== null, "taken");
  await assert.rejects(sendCommand(server, "run-1", RAISE), { name: "RunFinal" }, "the same raise again changes nothing: the run is final");
});

// Twin of cap-raise "two raises of a paused run at once (a retry) resume it once".
test("two raises of a parked run at once bring it back once: one claim, one loop, both rows taken by it", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const faux = fauxLoops({ park: true, turns: 3, turnMs: 20 });
  // Commands are read once the run is held: both rows land before the next claim's first poll.
  const runner = startRunner({ store: observed(store, record), createLoop: faux.createLoop, name: "runner-a", ...TIMING, pollMs: 200 });
  t.after(() => runner.close());
  await queue(server, "run-1");
  await parkedAndReleased(server, "run-1");

  const [one, two] = await Promise.all([sendCommand(server, "run-1", RAISE), sendCommand(server, "run-1", RAISE)]);
  await until(async () => (await server.runs.get("run-1")).state === "ended", "the run ends");
  assert.deepEqual(record.claims.map((claim) => claim.epoch), [1, 2], "claimed once more, not twice");
  assert.equal(faux.loops.length, 2, "one loop resumes it");
  assert.deepEqual(faux.loops[1].received.map((command) => command.id), [one.id, two.id], "both raises reach that loop, in order");
  for (const id of [one.id, two.id]) assert.ok((await commandRow(server, "run-1", id)).takenAt !== null, `raise ${id} taken once`);
});

// Twin of workflow-cap-place's "place kept for a raised run" reds (#1944-4): a run brought back by a raise is claimed
// before a run queued after it, when the runner's one loop frees.
test("a full runner: the run a raise brings back is claimed before a run queued after it", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const parks = fauxLoops({ park: true, turns: 2, turnMs: 10 });
  const longRun = fauxLoops({ turns: 25, turnMs: 20 });
  const plain = fauxLoops({ turns: 2, turnMs: 10 });
  const createLoop = (deps) => {
    // run-parked parks once, then ends; run-long holds the runner's only loop for a while; run-newer just runs.
    let inner;
    const kind = (runId) => (runId === "run-parked" ? parks : runId === "run-long" ? longRun : plain);
    return {
      start: (claim) => (inner = kind(claim.runId).createLoop(deps)).start(claim),
      command: (command) => inner.command(command),
      stop: (reason) => inner.stop(reason),
    };
  };
  const runner = startRunner({ store: observed(store, record), createLoop, name: "runner-a", loops: 1, ...TIMING });
  t.after(() => runner.close());
  await queue(server, "run-parked");
  await parkedAndReleased(server, "run-parked");
  await queue(server, "run-long");
  await until(() => record.claims.some((claim) => claim.runId === "run-long"), "the long run holds the one loop");

  await sendCommand(server, "run-parked", RAISE);
  await sleep(5);
  await queue(server, "run-newer");
  await until(async () => (await server.runs.get("run-newer")).state === "ended", "every run ends", 15_000);
  const order = record.claims.map((claim) => claim.runId);
  assert.deepEqual(order, ["run-parked", "run-long", "run-parked", "run-newer"], "the raised run before the newer queued one");
});
