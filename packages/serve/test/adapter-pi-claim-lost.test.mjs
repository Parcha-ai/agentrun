// B2c: a claim lost mid-turn ends the session through the adapter, on pi through the adapter loop (runner/adapter-loop.ts).
// On a claim loss (the runner's self-stop at the renew deadline, or a renew refused as Fenced once another runner took the
// claim) the loop ends its session with the adapter's interrupt() and then close(), once each and in that order; nothing
// of the lost claim's epoch reaches the store after the loss; and the run can be claimed again. This is the path a CLI
// adapter's kill rides once the CLI adapters run on this loop (E): interrupt() is where the adapter stops its process.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { nextOrder, observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");

const TIMING = { leaseMs: 600, renewEveryMs: 100, stopMarginMs: 200, pollMs: 20, commandPollMs: 20 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A runner on run-1 whose pi session is mid-turn in the slow tool, with its session's interrupt and close spied on. */
async function midTurn(t, timing = {}) {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const { tools, letSlowGo, slowStarted } = suiteTools();
  const calls = [];
  const stops = [];
  const base = piAdapterSpec({ script: [{ call: "slow" }, { say: "done" }], tools, hooks: quiet });
  const spec = async (claim, run) => {
    const given = await base(claim, run);
    const open = given.adapter.open;
    const adapter = {
      ...given.adapter,
      open: async (sessionSpec, io) => {
        const session = await open(sessionSpec, io);
        const interrupt = session.interrupt.bind(session);
        const close = session.close.bind(session);
        session.interrupt = async () => (calls.push({ call: "interrupt", epoch: claim.epoch, order: nextOrder() }), interrupt());
        session.close = async () => (calls.push({ call: "close", epoch: claim.epoch, order: nextOrder() }), close());
        return session;
      },
    };
    return { ...given, adapter };
  };
  const inner = createAdapterLoop(spec);
  // The loop's stop as the runner tells it, in the order things happened.
  const createLoop = (deps) => {
    const loop = inner(deps);
    return { ...loop, stop: (reason) => (stops.push({ kind: reason.kind, order: nextOrder() }), loop.stop(reason)) };
  };
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING, ...timing });
  t.after(async () => {
    letSlowGo();
    await runner.close();
  });
  await slowStarted;
  return { ...opened, record, runner, calls, stops, letSlowGo };
}

/** The checks both losses share: interrupt then close, once each, for epoch 1; no epoch 1 commit after the stop. */
function endedThroughTheAdapter({ calls, stops, record }) {
  const stop = stops.find((each) => each.kind === "claim-lost");
  assert.ok(stop, `the runner stopped the loop for its lost claim: ${JSON.stringify(stops)}`);
  const epochOne = calls.filter((call) => call.epoch === 1);
  assert.deepEqual(epochOne.map((call) => call.call), ["interrupt", "close"], "the session ended with interrupt() then close(), once each");
  assert.ok(epochOne[0].order > stop.order, "interrupt() came after the loss");
  assert.deepEqual(record.commits.filter((commit) => commit.epoch === 1 && commit.startedOrder > stop.order), [], "no commit of epoch 1 started after the loss lands");
}

test("pi through the adapter: a claim lost at the renew deadline mid-turn ends the session with interrupt then close, writes nothing after, and the run is claimed again", async (t) => {
  const world = await midTurn(t);
  world.record.blockRenew.add("runner-a");
  await until(() => world.stops.some((each) => each.kind === "claim-lost"), "the runner stops the loop at its renew deadline", TIMING.leaseMs * 3);
  await until(() => world.calls.filter((call) => call.epoch === 1).length >= 2, "the session ended", 5_000).catch(() => undefined);
  await sleep(TIMING.leaseMs);
  endedThroughTheAdapter(world);
  // Reclaimable: with renews working again the run is claimed at a new epoch and ends there.
  world.record.blockRenew.delete("runner-a");
  world.letSlowGo();
  const row = await until(async () => {
    const now = await world.server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run claimed again and ended", 15_000);
  assert.ok(row.epoch >= 2, `claimed again at a new epoch (${row.epoch})`);
});

test("pi through the adapter: a claim fenced mid-turn (another runner took it) ends the session with interrupt then close, and writes nothing after", async (t) => {
  // The runner claims at its start and polls no more: the jumped clock must not let it claim the run again itself.
  const world = await midTurn(t, { pollMs: 60_000 });
  // The clock jumps past the lease; a renewal on the jumped clock may land before the other runner's claim and hold the run
  // a lease past it, so the clock jumps again past each such renewal (one reaches at most a lease ahead) until the claim
  // lands. Whatever renews meanwhile, the claim lands at epoch 2 and every renewal after it is fenced.
  let taken;
  for (let jumps = 1; !taken && jumps <= 5; jumps++) {
    world.clock.skewMs = TIMING.leaseMs * 2 * jumps;
    taken = await world.server.claim("run-1", "runner-z", { leaseMs: 60_000 });
  }
  assert.equal(taken?.epoch, 2, "the other runner's claim: the run was claimable");
  await until(() => world.stops.some((each) => each.kind === "claim-lost"), "the runner stops the loop", TIMING.renewEveryMs * 6);
  await until(() => world.calls.filter((call) => call.epoch === 1).length >= 2, "the session ended", 5_000).catch(() => undefined);
  await sleep(TIMING.renewEveryMs * 3);
  endedThroughTheAdapter(world);
});
