// A run parked at its cap waits for a raise or a person, and no runner holds it meanwhile (#2204). A cancel or a stop of
// it ends it at once: its next claim only ends it, with no loop, so nothing of the run runs again and its claim is never
// taken in a loop (its loop would park it again on the same budget and leave the cancel untaken, and the run be claimed
// again at every poll). And with nothing to wake it, a parked run is never claimed again.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";
import { capRun, SONNET, sleep, specCap, STEADY } from "./adapter-pi-cap-support.mjs";

const { sendCommand } = await import("../dist/runner/commands.js");
after(closeOpenSessions);
const CAP = 0.01;

/** The run parked at its cap, its runner still up. */
const parked = async (t) => {
  const run = await capRun(t, { script: [{ say: "never sent" }], cap: specCap(CAP), runCap: ({ capUsd: () => CAP, modelOf: () => SONNET }) });
  assert.deepEqual([run.row.state, run.row.runner], ["parked", null], JSON.stringify(run.row));
  return run;
};

const until = async (done, what, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(20);
  }
};

test("a parked run with nothing to wake it is never claimed again: its epoch stays where its park left it", async (t) => {
  const { row, server } = await parked(t);
  await sleep(STEADY.pollMs * 25);
  const now = await server.runs.get("run-1");
  assert.deepEqual([now.state, now.epoch, now.runner], ["parked", row.epoch, null], `no claim since its park: ${JSON.stringify(now)}`);
});

for (const [kind, summary] of [["cancel", "cancelled"], ["stop", "stopped by a person"]]) {
  test(`a ${kind} of a run parked at its cap ends it at once, its ${kind} row taken, and it is never claimed again`, async (t) => {
    const { row, server, sent } = await parked(t);
    const command = await sendCommand(server, "run-1", { kind, body: {} });
    const ended = await until(async () => {
      const now = await server.runs.get("run-1");
      return now.state === "stopped" && now.runner === null && now;
    }, `the ${kind} ended the run`);
    assert.equal(ended.summary, summary);
    assert.equal(ended.epoch, row.epoch + 2, `one claim that only ended it (its claim and its end each move the epoch once): ${JSON.stringify(ended)}`);
    const taken = (await server.commands("run-1", 0)).find((one) => one.id === command.id);
    assert.ok(taken.takenAt !== null && taken.refused === null, `the ${kind} row is taken, not refused: ${JSON.stringify(taken)}`);
    assert.equal(sent.length, 0, "nothing of the run was sent after its park");
    await sleep(STEADY.pollMs * 25);
    assert.equal((await server.runs.get("run-1")).epoch, ended.epoch, "and it is never claimed again");
  });
}
