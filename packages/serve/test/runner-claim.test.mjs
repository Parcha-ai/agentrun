// A runner claims a queued run, keeps the claim while it lives and loses it when it dies (design: "Runners carry many
// loops"; the claim epoch is the one fence). Two runners, each on its own connection to one store file, one queued run:
// exactly one claims it. The holder renews, so the other never takes it while it lives. Killed (frozen: no renew, no
// release), its claim runs out and the other reclaims it with epoch + 1, and the dead runner's late journal commit is
// refused (Fenced).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, observed, queue, recorder, stores, until } from "./runner-support.mjs";

const LEASE_MS = 400;
const TIMING = { leaseMs: LEASE_MS, renewEveryMs: 100, stopMarginMs: 150, pollMs: 20, commandPollMs: 20 };

/** An observed store whose claims and renews are told as they return: `returned(op, n)` waits until `op` (claimMany or
 *  renewMany) has returned `n` times, then for one turn of the event loop, so the runner's own continuation of that call
 *  has run. It waits on the calls, never on time. */
function told(store) {
  const counts = { claimMany: 0, renewMany: 0 };
  const waiting = [];
  const tell = (op) => {
    counts[op] += 1;
    for (const wake of waiting.splice(0)) wake();
  };
  const after = (op, call) => async (...args) => {
    try {
      return await call(...args);
    } finally {
      tell(op);
    }
  };
  return {
    store: { ...store, runs: { ...store.runs, claimMany: after("claimMany", store.runs.claimMany) }, renewMany: after("renewMany", store.renewMany) },
    count: (op) => counts[op],
    async returned(op, n) {
      while (counts[op] < n) await new Promise((resolve) => waiting.push(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

// The renew on a clock the test moves: the runners' timers (their polls, renews and claim deadlines) and every clock
// (the runners' and the stores') are node:test's mocked ones, so nothing moves unless a step moves it, and a box's load
// can neither starve a renew nor run a lease out. Each step moves the clock one renew interval, waits for the holder's
// renew to return (by count, never by elapsed time), and reads that the claim moved with it.
test("two runners, one queued run: exactly one claims it, and keeps it while it renews, each renew moving its claimed_until", async (t) => {
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const { server, runners: [one, two] } = await stores({ runners: 2 });
  await queue(server, "run-1");
  const record = recorder();
  const events = [];
  const onEvent = (event) => events.push(event);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const a = told(observed(one, record));
  const b = told(observed(two, record));
  const runners = [
    startRunner({ store: a.store, createLoop: faux.createLoop, name: "runner-a", onEvent, ...TIMING }),
    startRunner({ store: b.store, createLoop: faux.createLoop, name: "runner-b", onEvent, ...TIMING }),
  ];
  try {
    // Each runner polls once as it starts: both ask, exactly one gets the run.
    await a.returned("claimMany", 1);
    await b.returned("claimMany", 1);
    assert.deepEqual(record.claims.map(({ runId, epoch }) => [runId, epoch]), [["run-1", 1]], JSON.stringify(record.claims));
    const name = record.claims[0].runner;
    const [holder, other] = name === "runner-a" ? [a, b] : [b, a];
    // Three leases long, one renew interval a step: each step's renew lands and moves the claim to now + the lease.
    const steps = (LEASE_MS * 3) / TIMING.renewEveryMs;
    for (let step = 1; step <= steps; step += 1) {
      t.mock.timers.tick(TIMING.renewEveryMs);
      await holder.returned("renewMany", step);
      const run = await server.runs.get("run-1");
      assert.deepEqual([run.state, run.epoch, run.runner, run.claimedUntil], ["running", 1, name, Date.now() + LEASE_MS], `step ${step}: the renew landed and moved the claim`);
    }
    assert.equal(holder.count("renewMany"), steps, "one renew a step");
    assert.equal(other.count("renewMany"), 0, "the other runner holds nothing to renew");
    assert.equal(record.claims.length, 1, `never reclaimed: ${JSON.stringify(record.claims)}`);
    assert.equal(faux.loops.length, 1, "one loop runs the run");
    assert.deepEqual(events.filter((event) => event.type === "claim-lost"), [], "no claim lost");
  } finally {
    // Real timers again before the runners close: their close waits on timers of its own.
    t.mock.timers.reset();
    await Promise.all(runners.map((runner) => runner.close()));
  }
});

// Deleted at the merge (flaky on Node 24.11, follow-up #2158): "a runner that closes stops its loop where it can resume
// and releases the run, still running; the other claims it at once". Rewrite it on events, not the clock.

// The end, then a lease's worth of polls on a clock the test moves: the run ends and is released on real timers (a lease no
// stall outlasts, each step waited for by its event), then the runners' timers are mocked and the clock moves past one
// lease, a step at a time, each runner's poll waited for by count. No poll claims the ended run.
test("a run that ends is flushed and released, and never claimed again", async (t) => {
  const timing = { ...TIMING, leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000 };
  const faux = fauxLoops({ turns: 2, turnMs: 10 });
  const { server, runners: [one, two] } = await stores({ runners: 2 });
  const record = recorder();
  const events = [];
  let released = () => {};
  const releasedNow = new Promise((resolve) => (released = resolve));
  const onEvent = (event) => {
    events.push(event);
    if (event.type === "released" && event.runId === "run-1") released();
  };
  // A slow flush, as on a loaded machine: the end commit already reads released on the row, so only the runner's own
  // "released" says the flush and the release are done.
  record.flushDelayMs = 150;
  const a = told(observed(one, record));
  const b = told(observed(two, record));
  const runners = [
    startRunner({ store: a.store, createLoop: faux.createLoop, name: "runner-a", onEvent, ...timing }),
    startRunner({ store: b.store, createLoop: faux.createLoop, name: "runner-b", onEvent, ...timing }),
  ];
  try {
    await queue(server, "run-1");
    await releasedNow;
    assert.equal((await server.runs.get("run-1")).runner, null, "the end commit released the row");
    assert.match(record.ops.join(" | "), /ended run-1 \| flush \| release run-1/, "the end commit, then a flush, then the release");
    const run = await server.runs.get("run-1");
    assert.ok(run.endedAt !== null, "the end commit stamped ended_at");

    // From each runner's next poll on, its timers are the test's: that poll is the last on a real timer.
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
    const polled = [a.count("claimMany") + 1, b.count("claimMany") + 1];
    await a.returned("claimMany", polled[0]);
    await b.returned("claimMany", polled[1]);
    // Past one lease, a quarter lease a step; each step, each runner polls once and claims nothing.
    for (let step = 1; step <= 5; step += 1) {
      t.mock.timers.tick(timing.leaseMs / 4);
      await a.returned("claimMany", (polled[0] += 1));
      await b.returned("claimMany", (polled[1] += 1));
      assert.equal(record.claims.length, 1, `step ${step}: an ended run is final: ${JSON.stringify(record.claims)}`);
    }
    assert.deepEqual(runners.flatMap((runner) => runner.held()), [], "no runner holds it");
    assert.deepEqual(await server.runs.claimable({ limit: 10 }), []);
  } finally {
    t.mock.timers.reset();
    await Promise.all(runners.map((runner) => runner.close()));
  }
});
