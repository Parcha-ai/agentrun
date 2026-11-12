// A runner claims a queued run, keeps the claim while it lives and loses it when it dies (design: "Runners carry many
// loops"; the claim epoch is the one fence). Two runners, each on its own connection to one store file, one queued run:
// exactly one claims it. The holder renews, so the other never takes it while it lives. Killed (frozen: no renew, no
// release), its claim runs out and the other reclaims it with epoch + 1, and the dead runner's late journal commit is
// refused (Fenced).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, observed, queue, recorder, STEADY_LEASE, stores } from "./runner-support.mjs";

const LEASE_MS = 400;
const TIMING = { leaseMs: LEASE_MS, renewEveryMs: 100, stopMarginMs: 150, pollMs: 20, commandPollMs: 20 };

/** An observed store whose claims and renews are told as they return: `returned(op, n)` waits until `op` (claimMany or
 *  renewMany) has returned `n` times, then for one turn of the event loop, so the runner's own continuation of that call
 *  has run. It waits on the calls, never on time.
 *  Its reads of command rows wait for `readsAfter`: a runner reads its new claims' rows (one more store call, a round trip
 *  on Postgres) before it holds them, so a test that opens the gate only once both runners' claims are back holds the
 *  claim well after claimMany returned, as a slow store does, on any store. */
function told(store, { readsAfter } = {}) {
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
    store: {
      ...store,
      runs: { ...store.runs, claimMany: after("claimMany", store.runs.claimMany) },
      renewMany: after("renewMany", store.renewMany),
      commandsOf: async (cursors) => (await readsAfter, store.commandsOf(cursors)),
    },
    count: (op) => counts[op],
    async returned(op, n) {
      while (counts[op] < n) await new Promise((resolve) => waiting.push(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** The runners' "claimed" events as they come: `nth(n)` is the n-th claim a runner holds (its loop made, its renews due
 *  from then on). claimMany's return is not that moment: the runner reads the claim's command rows first. Waited for by
 *  the event, never by time. */
function claimedEvents() {
  const claims = [];
  const waiting = [];
  return {
    onEvent(event) {
      if (event.type !== "claimed") return;
      claims.push(event.claim);
      for (const wake of waiting.splice(0)) wake();
    },
    async nth(n) {
      while (claims.length < n) await new Promise((resolve) => waiting.push(resolve));
      return claims[n - 1];
    },
  };
}

// The renew on a clock the test moves: the runners' timers (their polls, renews and claim deadlines) and every clock
// (the runners' and the stores') are node:test's mocked ones, so nothing moves unless a step moves it, and a box's load
// can neither starve a renew nor run a lease out. Each step moves the clock one renew interval, waits for the holder's
// renew to return (by count, never by elapsed time), and reads that the claim moved with it.
// The mock goes on before either runner starts and before any store call of theirs, and off once their timers are done
// with: no store transaction straddles the switch (see the case below).
test("two runners, one queued run: exactly one claims it, and keeps it while it renews, each renew moving its claimed_until", { timeout: 60_000 }, async (t) => {
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const { server, runners: [one, two] } = await stores({ runners: 2 });
  await queue(server, "run-1");
  const record = recorder();
  const events = [];
  const held = claimedEvents();
  const onEvent = (event) => {
    events.push(event);
    held.onEvent(event);
  };
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  let readRows = () => {};
  const readsAfter = new Promise((resolve) => (readRows = resolve));
  const a = told(observed(one, record), { readsAfter });
  const b = told(observed(two, record), { readsAfter });
  const runners = [
    startRunner({ store: a.store, createLoop: faux.createLoop, name: "runner-a", onEvent, ...TIMING }),
    startRunner({ store: b.store, createLoop: faux.createLoop, name: "runner-b", onEvent, ...TIMING }),
  ];
  try {
    // Each runner polls once as it starts: both ask, exactly one gets the run.
    await a.returned("claimMany", 1);
    await b.returned("claimMany", 1);
    readRows();
    assert.deepEqual(record.claims.map(({ runId, epoch }) => [runId, epoch]), [["run-1", 1]], JSON.stringify(record.claims));
    const name = record.claims[0].runner;
    const [holder, other] = name === "runner-a" ? [a, b] : [b, a];
    // The holder holds it once it has read the claim's command rows: no step moves the clock before then, or its renew
    // would find nothing to renew and no later step would come.
    const claim = await held.nth(1);
    assert.deepEqual([claim.runId, claim.epoch, claim.runner], ["run-1", 1, name], "the claim held is the one that landed");
    assert.deepEqual(runners.find((runner) => runner.name !== name).held(), [], "the other runner holds nothing: the run is claimed");
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

// A runner that closes hands its run back: the loop is stopped for a shutdown where it can resume, the store is flushed, the
// run released (its epoch moves on), and the other runner claims it at once, one epoch further. A claim and its epoch are the
// fence, so this one is kept, and made deterministic: the lease is one no stall outlasts (STEADY_LEASE), so the other runner
// can only have the run through the close's release, never through the old claim lapsing, and nothing is read off a clock.
// Each step is waited for by its event (a runner's "claimed": the claim held, its loop made), never by a poll.
test("a runner that closes stops its loop where it can resume and releases the run, still running; the other claims it at once", async (t) => {
  const timing = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 20 };
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const { server, runners: [one, two] } = await stores({ runners: 2 });
  const record = recorder();
  const held = claimedEvents();
  const onEvent = (event) => held.onEvent(event);
  let readRows = () => {};
  const readsAfter = new Promise((resolve) => (readRows = resolve));
  await queue(server, "run-1");
  const a = told(observed(one, record), { readsAfter });
  const b = told(observed(two, record), { readsAfter });
  const runners = [
    startRunner({ store: a.store, createLoop: faux.createLoop, name: "runner-a", onEvent, ...timing }),
    startRunner({ store: b.store, createLoop: faux.createLoop, name: "runner-b", onEvent, ...timing }),
  ];
  // Close is idempotent: the holder's is already done when this runs.
  t.after(() => Promise.all(runners.map((runner) => runner.close())));

  // Each runner polls once as it starts: both claims are back before the claim's rows are read.
  await a.returned("claimMany", 1);
  await b.returned("claimMany", 1);
  readRows();
  const first = await held.nth(1);
  assert.deepEqual(record.claims.map(({ runId, runner, epoch }) => [runId, runner, epoch]), [["run-1", first.runner, 1]], "exactly one claim, the one held");
  const holder = runners.find((runner) => runner.name === first.runner);
  const other = runners.find((runner) => runner !== holder);
  const leaseEnd = (await server.runs.get("run-1")).claimedUntil;
  await holder.close();

  assert.equal(faux.loops[0].stopCalls[0]?.kind, "shutdown", "the loop is stopped for a shutdown");
  assert.match(record.ops.join(" | "), /flush \| release run-1/, "flushed, then released");
  const second = await held.nth(2);
  // The close's release moved the epoch to 2: the other runner's claim is 3.
  assert.deepEqual([second.runner, second.epoch], [other.name, 3]);
  assert.ok(record.claims[1].at < leaseEnd, "claimed before the old lease would have run out: it was handed back, not lapsed");
  // The runner makes the loop before it says "claimed".
  assert.equal(faux.loops[1].claim.epoch, 3, "a new loop resumes it");
  assert.equal((await server.runs.get("run-1")).state, "running", "still running");
});

// The end, then polls past a lease on the stores' clock: the run ends and is released on real timers (a lease no stall
// outlasts, each step waited for by its event), then the stores' clock (the one every store judges a lease on) moves past
// one lease, a quarter lease a step, and each runner's next poll is waited for by count. No poll claims the ended run.
// Never node:test's mocked timers here: the runners poll all along, so a store transaction begun on real timers would end
// under the mock, whose clearInterval cannot clear its real deadline tick (store/deadline.ts runnableDeadline). That
// tick, left ref'd, held the file's process open after both cases passed, until the CI shard was cut.
test("a run that ends is flushed and released, and never claimed again", { timeout: 60_000 }, async (t) => {
  const timing = { ...TIMING, leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000 };
  const faux = fauxLoops({ turns: 2, turnMs: 10 });
  const { server, runners: [one, two], clock } = await stores({ runners: 2 });
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

    // Past one lease on the stores' clock, a quarter lease a step; each step, each runner's next poll (one sent after the
    // move) returns, and nothing is claimed.
    for (let step = 1; step <= 5; step += 1) {
      clock.skewMs += timing.leaseMs / 4;
      const polled = [a.count("claimMany") + 2, b.count("claimMany") + 2];
      await a.returned("claimMany", polled[0]);
      await b.returned("claimMany", polled[1]);
      assert.equal(record.claims.length, 1, `step ${step}: an ended run is final: ${JSON.stringify(record.claims)}`);
    }
    assert.deepEqual(runners.flatMap((runner) => runner.held()), [], "no runner holds it");
    assert.deepEqual(await server.runs.claimable({ limit: 10 }), []);
  } finally {
    await Promise.all(runners.map((runner) => runner.close()));
  }
});
