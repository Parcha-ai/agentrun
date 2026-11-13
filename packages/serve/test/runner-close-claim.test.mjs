// A runner's close waits for a claim its poll already has in flight: once close resolves, the runner claims nothing. Its
// poll's claimMany is held here (a slow store under load) while a run is queued and close is called; the claim then
// lands, finds the runner closing and gives the run back, all before close resolves. Without the wait, close resolved at
// once and the claim landed after it: a raise sent then (runner-cap-raise) woke a claim by a closed runner, which gave
// the run back, two epochs on. Ordered by events, never by time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, observed, queue, recorder, stores } from "./runner-support.mjs";

const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };

test("a runner's close resolves only after the claim its poll had in flight, and nothing it claims lands after close", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const faux = fauxLoops({ turns: 2, turnMs: 10 });
  let order = 0;
  const seen = [];
  const held = [];
  let arm = false;
  let heldNow = () => {};
  let heldReturned = () => {};
  const returned = new Promise((resolve) => (heldReturned = resolve));
  const observedStore = observed(store, record);
  const holding = {
    ...observedStore,
    runs: {
      ...observedStore.runs,
      async claimMany(...args) {
        const armed = arm;
        if (armed) {
          arm = false;
          await new Promise((resolve) => (held.push(resolve), heldNow()));
        }
        const claims = await observedStore.runs.claimMany(...args);
        seen.push({ what: armed ? "held claim returned" : "claim returned", order: ++order, claims: claims.map(({ runId, epoch }) => [runId, epoch]) });
        if (armed) heldReturned();
        return claims;
      },
    },
  };
  const runner = startRunner({ store: holding, createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  // The poll's next claim, held in flight.
  const inFlight = new Promise((resolve) => (heldNow = resolve));
  arm = true;
  await inFlight;
  await queue(server, "run-1");
  const closing = runner.close().then(() => seen.push({ what: "close resolved", order: ++order }));
  // Two turns of the event loop: a close that does not wait has resolved by now.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  held[0]();
  await closing;
  await returned;
  // The claim's give-back, when it claimed after close: its release is the runner's own, under the claim it made.
  await new Promise((resolve) => setImmediate(resolve));
  const history = JSON.stringify(seen);
  const claimed = seen.find((event) => event.what === "held claim returned");
  const closed = seen.find((event) => event.what === "close resolved");
  assert.deepEqual(claimed.claims, [["run-1", 1]], `the claim in flight claimed the run queued meanwhile: ${history}`);
  assert.ok(claimed.order < closed.order, `the claim in flight returned before close resolved: ${history}`);
  assert.deepEqual(seen.filter((event) => event.what.endsWith("claim returned") && event.claims.length > 0 && event.order > closed.order), [], `nothing claimed after close: ${history}`);
  const run = await server.runs.get("run-1");
  assert.equal(run.runner, null, "the run it claimed while closing is given back");
  assert.equal(faux.loops.length, 0, "no loop started on it");
});
