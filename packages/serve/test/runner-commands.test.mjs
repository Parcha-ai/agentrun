// Commands from the console are rows, not files or doors (design: "Commands from the console are rows"). A stop and a
// steer row reach the running loop within one poll; each row's taken_at is set by the commit that applies it. A command
// for an ended run is refused: by the insert once the run is final, and by the runner for a row that landed while the
// run was ending. A parked run holds no runner; an approve row makes it claimable, and the next loop receives it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
import { commandRow, fauxLoops, observed, queue, recorder, sleep, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const POLL_MS = 50;
const TIMING = { ...STEADY_LEASE, pollMs: 20 };

async function runner(t, createLoop, timing = {}, storeOf = (store) => store) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const started = startRunner({ store: storeOf(observed(store, record)), createLoop, name: "runner-a", commandPollMs: POLL_MS, ...TIMING, ...timing });
  t.after(() => started.close());
  return { server, record };
}

test("a steer and then a stop reach the running loop within one poll, and each row's taken_at is set", async (t) => {
  const faux = fauxLoops({ turns: 1_000, turnMs: 10 });
  const { server } = await runner(t, faux.createLoop);
  await queue(server, "run-1");
  const loop = await until(() => faux.loops[0]?.claim && faux.loops[0], "the loop runs");

  const steer = await sendCommand(server, "run-1", { kind: "steer", body: { text: "check the totals" } });
  const sentAt = Date.now();
  const received = await until(() => loop.received.find((command) => command.id === steer.id), "the steer reaches the loop");
  assert.ok(received.at - sentAt <= POLL_MS * 2, `the steer took ${received.at - sentAt} ms (one poll is ${POLL_MS})`);
  assert.deepEqual(received.body, { text: "check the totals" });
  const taken = await until(async () => (await commandRow(server, "run-1", steer.id)).takenAt !== null && commandRow(server, "run-1", steer.id), "the steer's taken_at");
  assert.equal(taken.refused, null);

  const stop = await sendCommand(server, "run-1", { kind: "stop" });
  const stoppedAt = Date.now();
  await until(() => loop.stopCalls[0], "the stop reaches the loop");
  assert.deepEqual([loop.stopCalls[0].kind, loop.stopCalls[0].commandId], ["command", stop.id]);
  assert.ok(loop.stopCalls[0].at - stoppedAt <= POLL_MS * 2, `the stop took ${loop.stopCalls[0].at - stoppedAt} ms`);
  await until(async () => (await server.runs.get("run-1")).state === "stopped", "the run is stopped");
  const row = await commandRow(server, "run-1", stop.id);
  assert.ok(row.takenAt !== null, "the stop's taken_at is set by the stopped commit");
  assert.equal(row.refused, null);
  assert.equal(loop.received.some((command) => command.kind === "stop"), false, "a stop comes as stop(), never as a command");
});

test("a command for an ended run is refused: in the insert once it is final, and by the runner for one that came as it ended", async (t) => {
  // Long enough that the steer is sent while the run still runs.
  const faux = fauxLoops({ turns: 40, turnMs: 25 });
  // The runner never polls before the run ends, so a steer sent while it runs is still untaken at the end. The claim's
  // first delivery reads the run's rows once: a steer sent before that read is the loop's, never a late one. That read is
  // held here until the test lets it go (a loaded machine's slow first read), and the steer is sent only once the first
  // delivery is done (LoopDeps.delivered): the order comes from that, never from a clock. (The 10 s is a failure bound.)
  let letFirstReadGo;
  const firstReadMayGo = new Promise((resolve) => (letFirstReadGo = resolve));
  let firstRead = true;
  const slowFirstRead = (store) => ({
    ...store,
    commands: async (runId, after) => {
      if (firstRead) {
        firstRead = false;
        await Promise.race([firstReadMayGo, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
      }
      return store.commands(runId, after);
    },
  });
  const { server } = await runner(t, faux.createLoop, { commandPollMs: 60_000 }, slowFirstRead);
  await queue(server, "run-1");
  await until(() => faux.loops[0]?.claim, "the loop runs");
  letFirstReadGo();
  await faux.loops[0].deps.delivered;
  const late = await sendCommand(server, "run-1", { kind: "steer", body: { text: "one more thing" } });

  await until(async () => (await server.runs.get("run-1")).state === "ended", "the run ends");
  const row = await until(async () => {
    const now = await commandRow(server, "run-1", late.id);
    return now.takenAt !== null && now;
  }, "the runner settles the late steer");
  assert.match(row.refused ?? "", /ended/, `the late steer is refused with the reason: ${JSON.stringify(row)}`);
  assert.equal(faux.loops[0].received.length, 0, "the loop never received it");

  await assert.rejects(sendCommand(server, "run-1", { kind: "steer", body: { text: "too late" } }), { name: "RunFinal" });
  await assert.rejects(sendCommand(server, "run-1", { kind: "stop" }), { name: "RunFinal" });
});

test("a command of no known kind, or a body its kind cannot take, is refused before it is a row", async (t) => {
  const { server } = await stores({ runners: 0 });
  await queue(server, "run-1");
  await assert.rejects(sendCommand(server, "run-1", { kind: "dance" }), /kind/);
  await assert.rejects(sendCommand(server, "run-1", { kind: "steer", body: {} }), /text/);
  assert.deepEqual(await server.commands("run-1", 0), []);
});

test("a parked run is released; an approve row brings it back to a runner, and the new loop receives it", async (t) => {
  const faux = fauxLoops({ park: true, turns: 2, turnMs: 10 });
  const { server, record } = await runner(t, faux.createLoop);
  await queue(server, "run-1");

  await until(async () => {
    const run = await server.runs.get("run-1");
    return run.state === "parked" && run.runner === null;
  }, "the parked run is released");
  await sleep(POLL_MS * 3);
  assert.equal(record.claims.length, 1, "a parked run with no command is not claimed again");

  const approve = await sendCommand(server, "run-1", { kind: "approve", body: { approval: "a-1" } });
  await until(async () => (await server.runs.get("run-1")).state === "ended", "the resumed run ends");
  assert.equal(record.claims.length, 2);
  // The park's release bumped the epoch to 2: the second claim is 3.
  assert.equal(record.claims[1].epoch, 3);
  assert.deepEqual(faux.loops[1].received.map((command) => command.id), [approve.id], "the second loop received the approve");
  assert.ok((await commandRow(server, "run-1", approve.id)).takenAt !== null);
});
