// LoopDeps.delivered: a loop resumed by a command row can wait until the runner has handed it every untaken row the
// claim's first read found, so a resumed ask with no answer yet parks again only once an approve already on its way has
// reached it (the lead's read of #1969, P2-2's runner half). A row a loop answers { later } is neither taken nor refused:
// it waits, untaken, for the run's next claim, which hands it on again (P2-3's runner half: a steer that comes as the run
// parks is the resume's).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
import { commandRow, observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 2_000 };

test("deps.delivered resolves once the first read's untaken rows have reached the loop's command()", async (t) => {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const steer = await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "already on its way" } });
  const seen = {};
  const createLoop = (deps) => {
    const received = [];
    return {
      start: async () => {
        await deps.delivered;
        seen.atDelivered = received.map((row) => row.id);
        return { state: "ended" };
      },
      command: async (row) => (received.push(row), { taken: true }),
      stop: async () => {},
    };
  };
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => seen.atDelivered !== undefined, "the loop's start past deps.delivered");
  assert.deepEqual(seen.atDelivered, [steer.id], "the steer already on its way had reached the loop");
});

test("a row the loop answers { later } stays untaken through the run's park, and its next claim hands it on again", async (t) => {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  let claims = 0;
  const handed = [];
  const createLoop = (deps) => {
    const n = ++claims;
    return {
      start: async () => {
        await deps.delivered;
        // Claim 1 parks with the steer left for later; claim 2 takes it and ends.
        return n === 1 ? { state: "parked" } : { state: "ended" };
      },
      command: async (row) => {
        // As the next claim gets it, the row is as claim 1 left it: untaken, never refused.
        const stored = await commandRow(opened.server, "run-1", row.id);
        handed.push({ claim: n, id: row.id, takenAt: stored.takenAt, refused: stored.refused });
        return n === 1 ? { later: "the run is parking: its resume takes this" } : { refused: "not in this test" };
      },
      stop: async () => {},
    };
  };
  const steer = await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "as it parks" } });
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => handed.some((hand) => hand.claim === 2), "the next claim hands the steer on again", 5_000);
  assert.deepEqual(handed.map((hand) => [hand.claim, hand.id, hand.takenAt, hand.refused]), [[1, steer.id, null, null], [2, steer.id, null, null]]);
});
