// Commands from the console are rows, not files or doors (design: "Commands from the console are rows"). A stop and a
// steer row reach the running loop within one poll; each row's taken_at is set by the commit that applies it. A command
// for an ended run is refused: by the insert once the run is final, and by the runner for a row that landed while the
// run was ending. A parked run holds no runner; an approve row makes it claimable, and the next loop receives it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
import { fauxLoops, sleep, storeDouble, until } from "./runner-support.mjs";

const POLL_MS = 50;
const TIMING = { leaseMs: 2_000, renewEveryMs: 500, stopMarginMs: 500, pollMs: 20 };

function runner(t, store, createLoop, timing = {}) {
  const started = startRunner({ store, createLoop, name: "runner-a", commandPollMs: POLL_MS, ...TIMING, ...timing });
  t.after(() => started.close());
  return started;
}

test("a steer and then a stop reach the running loop within one poll, and each row's taken_at is set", async (t) => {
  const store = storeDouble();
  const faux = fauxLoops({ turns: 1_000, turnMs: 10 });
  await store.runs.create("run-1");
  runner(t, store, faux.createLoop);
  const loop = await until(() => faux.loops[0]?.claim && faux.loops[0], "the loop runs");

  const steer = await sendCommand(store, "run-1", { kind: "steer", body: { text: "check the totals" } });
  const sentAt = Date.now();
  const received = await until(() => loop.received.find((command) => command.id === steer.id), "the steer reaches the loop");
  assert.ok(received.at - sentAt <= POLL_MS * 2, `the steer took ${received.at - sentAt} ms (one poll is ${POLL_MS})`);
  assert.deepEqual(received.body, { text: "check the totals" });
  await until(() => store.commandRows.find((command) => command.id === steer.id).takenAt, "the steer's taken_at");
  assert.equal(store.commandRows.find((command) => command.id === steer.id).refused, null);

  const stop = await sendCommand(store, "run-1", { kind: "stop" });
  const stoppedAt = Date.now();
  await until(() => loop.stopCalls[0], "the stop reaches the loop");
  assert.deepEqual([loop.stopCalls[0].kind, loop.stopCalls[0].commandId], ["command", stop.id]);
  assert.ok(loop.stopCalls[0].at - stoppedAt <= POLL_MS * 2, `the stop took ${loop.stopCalls[0].at - stoppedAt} ms`);
  await until(async () => (await store.runs.get("run-1")).state === "stopped", "the run is stopped");
  const row = store.commandRows.find((command) => command.id === stop.id);
  assert.ok(row.takenAt, "the stop's taken_at is set by the stopped commit");
  assert.equal(loop.received.some((command) => command.kind === "stop"), false, "a stop comes as stop(), never as a command");
});

test("a command for an ended run is refused: in the insert once it is final, and by the runner for one that came as it ended", async (t) => {
  const store = storeDouble();
  const faux = fauxLoops({ turns: 4, turnMs: 25 });
  await store.runs.create("run-1");
  // The runner never polls before the run ends, so a steer sent while it runs is still untaken at the end.
  runner(t, store, faux.createLoop, { commandPollMs: 60_000 });
  await until(() => faux.loops[0]?.claim, "the loop runs");
  const late = await sendCommand(store, "run-1", { kind: "steer", body: { text: "one more thing" } });

  await until(async () => (await store.runs.get("run-1")).state === "ended", "the run ends");
  await until(() => store.commandRows.find((command) => command.id === late.id).takenAt, "the runner settles the late steer");
  const row = store.commandRows.find((command) => command.id === late.id);
  assert.match(row.refused ?? "", /ended/, `the late steer is refused with the reason: ${JSON.stringify(row)}`);
  assert.equal(faux.loops[0].received.length, 0, "the loop never received it");

  await assert.rejects(sendCommand(store, "run-1", { kind: "steer", body: { text: "too late" } }), { name: "RunFinal" });
  await assert.rejects(sendCommand(store, "run-1", { kind: "stop" }), { name: "RunFinal" });
});

test("a command of no known kind is refused before it is a row", async (t) => {
  const store = storeDouble();
  await store.runs.create("run-1");
  await assert.rejects(sendCommand(store, "run-1", { kind: "dance" }), /kind/);
  await assert.rejects(sendCommand(store, "run-1", { kind: "steer", body: {} }), /text/);
  assert.equal(store.commandRows.length, 0);
});

test("a parked run is released; an approve row brings it back to a runner, and the new loop receives it", async (t) => {
  const store = storeDouble();
  const faux = fauxLoops({ park: true, turns: 2, turnMs: 10 });
  await store.runs.create("run-1");
  runner(t, store, faux.createLoop);

  await until(async () => {
    const run = await store.runs.get("run-1");
    return run.state === "parked" && run.runner === null;
  }, "the parked run is released");
  await sleep(POLL_MS * 3);
  assert.equal(store.claims.length, 1, "a parked run with no command is not claimed again");

  const approve = await sendCommand(store, "run-1", { kind: "approve", body: { approval: "a-1" } });
  await until(async () => (await store.runs.get("run-1")).state === "ended", "the resumed run ends");
  assert.equal(store.claims.length, 2);
  assert.equal(store.claims[1].epoch, 2);
  assert.deepEqual(faux.loops[1].received.map((command) => command.id), [approve.id], "the second loop received the approve");
  assert.ok(store.commandRows.find((command) => command.id === approve.id).takenAt);
});
