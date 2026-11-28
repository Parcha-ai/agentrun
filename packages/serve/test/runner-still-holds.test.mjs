// The runner's fence on a claim, as its loop reads it (LoopDeps.stillHolds): what the run's end asks before it sweeps the
// run's scratch (spec-holds.ts), since a lost claim's run folder may be a later claim's. It says held while this runner
// holds the claim, a shutdown's stop included (its claims are renewed while the loops stop), and lost once a renew is
// answered Fenced, a shutdown's too: the claim signal's reason is then still the shutdown's, which is why the end reads
// the fence and never the reason. The loop here holds its claim until the test lets it end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

// A long lease, so only a case's own move loses the claim; a short renew tick, so a Fenced answer comes within one. The
// runner claims at its start and polls no more: the jumped clock must not let it claim the run again itself.
const TIMING = { ...STEADY_LEASE, renewEveryMs: 100, pollMs: 60_000, commandPollMs: 20, drainMs: 0 };
const WAIT_MS = 10_000;

/** A loop that holds its claim until `end()`, and records its stops. */
function heldLoops() {
  const loops = [];
  const createLoop = (deps) => {
    let end;
    const ended = new Promise((resolve) => (end = resolve));
    const loop = {
      deps,
      stops: [],
      started: false,
      end: () => end(),
      async start() {
        loop.started = true;
        await ended;
        return { state: "interrupted" };
      },
      async command() {
        return { taken: true };
      },
      async stop(reason) {
        loop.stops.push(reason);
      },
    };
    loops.push(loop);
    return loop;
  };
  return { loops, createLoop };
}

async function holding(t) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const faux = heldLoops();
  const events = [];
  const runner = startRunner({ store: opened.runners[0], createLoop: faux.createLoop, name: "runner-a", onEvent: (event) => events.push(event), ...TIMING });
  let closing;
  t.after(async () => {
    for (const loop of faux.loops) loop.end();
    await (closing ?? runner.close());
  });
  const loop = await until(() => faux.loops[0]?.started && faux.loops[0], "the loop holds its claim");
  return { ...opened, runner, events, loop, close: () => (closing ??= runner.close()) };
}

/** Another runner takes the run: the store's clock jumps past the claim's until and the epoch moves, so this runner's
 *  next renew is answered Fenced. */
async function takenOver(server, clock) {
  clock.skewMs = TIMING.leaseMs * 2;
  const taken = await server.claim("run-1", "runner-z", { leaseMs: 60_000 });
  assert.equal(taken?.epoch, 2, "the other runner's claim");
}

test("the fence holds while the runner holds the claim, and says lost once a renew is answered Fenced", async (t) => {
  const { server, clock, events, loop } = await holding(t);
  assert.equal(await loop.deps.stillHolds(), true, "held");
  await takenOver(server, clock);
  await until(() => events.some((event) => event.type === "claim-lost" && event.why === "fenced"), "the claim is lost on the Fenced renew", WAIT_MS);
  assert.equal(await loop.deps.stillHolds(), false, "lost");
  assert.equal(loop.deps.signal.reason?.name, "ClaimLost");
});

test("a shutdown's stop: the signal aborted, the claim renewed, the fence still held", async (t) => {
  const { loop, close } = await holding(t);
  void close();
  await until(() => loop.deps.signal.aborted, "the shutdown aborts the loop's signal", WAIT_MS);
  assert.equal(loop.deps.signal.reason?.message, "the runner is closing");
  assert.equal(await loop.deps.stillHolds(), true, "the claim is still this runner's while the loop stops");
  // Over a few renews.
  await new Promise((resolve) => setTimeout(resolve, TIMING.renewEveryMs * 3));
  assert.equal(await loop.deps.stillHolds(), true);
});

test("a claim lost after the shutdown's abort: the signal keeps the shutdown's reason, the fence says lost", async (t) => {
  const { server, clock, events, loop, close } = await holding(t);
  void close();
  await until(() => loop.deps.signal.aborted, "the shutdown aborts the loop's signal", WAIT_MS);
  await takenOver(server, clock);
  await until(() => events.some((event) => event.type === "claim-lost" && event.why === "fenced"), "the claim is lost on a Fenced renew during the stop", WAIT_MS);
  assert.equal(loop.deps.signal.reason?.message, "the runner is closing", "an abort is once: the reason is still the shutdown's");
  assert.equal(await loop.deps.stillHolds(), false, "lost");
});
