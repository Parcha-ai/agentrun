// A runner claims a queued run, keeps the claim while it lives and loses it when it dies (design: "Runners carry many
// loops"; the claim epoch is the one fence). Two runners, each on its own connection to one store file, one queued run:
// exactly one claims it. The holder renews, so the other never takes it while it lives. Killed (frozen: no renew, no
// release), its claim runs out and the other reclaims it with epoch + 1, and the dead runner's late journal commit is
// refused (Fenced). A runner that closes releases its run still running, and the other claims it at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, observed, queue, recorder, sleep, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const LEASE_MS = 400;
const TIMING = { leaseMs: LEASE_MS, renewEveryMs: 100, stopMarginMs: 150, pollMs: 20, commandPollMs: 20 };

/** The steady lease, for a case whose point is not a lapse (a close's early release): a claim lost to a stall would turn
 *  it into the lapse case. */
const STEADY = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 20 };

/** The bound on a wait for a runner's own event: it caps the wait, it never orders anything. */
const EVENT_WAIT_MS = 30_000;

async function twoRunners(t, createLoop, timing = TIMING) {
  const { server, runners: [one, two] } = await stores({ runners: 2 });
  const record = recorder();
  const events = [];
  const onEvent = (event) => events.push(event);
  const started = [
    startRunner({ store: observed(one, record), createLoop, name: "runner-a", onEvent, ...timing }),
    startRunner({ store: observed(two, record), createLoop, name: "runner-b", onEvent, ...timing }),
  ];
  t.after(() => Promise.all(started.map((runner) => runner.close())));
  return { server, record, events, runners: started };
}

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

/** Waits, by event, until `check(record.commits)` holds: each landed commit the observed store records wakes it. */
function commitsTold(record) {
  const waiting = [];
  const push = record.commits.push.bind(record.commits);
  record.commits.push = (...commits) => {
    const length = push(...commits);
    for (const wake of waiting.splice(0)) wake();
    return length;
  };
  return async (check) => {
    while (!check(record.commits)) await new Promise((resolve) => waiting.push(resolve));
  };
}

// On the clock the test moves, as the renew case: the holder is killed, the clock moves one poll at a time, and each of
// the other runner's polls is waited for by count. Its claim comes only once the clock is past the holder's claimed_until,
// at epoch 2; the dead runner's late commit is Fenced; and the new holder's loop commits. No wait reads elapsed time.
test("the holder is killed: the other reclaims after claimed_until with epoch 2, and the dead one's late commit is Fenced", async (t) => {
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const { server, runners: [one, two] } = await stores({ runners: 2 });
  await queue(server, "run-1");
  const record = recorder();
  const committed = commitsTold(record);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const a = told(observed(one, record));
  const b = told(observed(two, record));
  const runners = [
    startRunner({ store: a.store, createLoop: faux.createLoop, name: "runner-a", ...TIMING }),
    startRunner({ store: b.store, createLoop: faux.createLoop, name: "runner-b", ...TIMING }),
  ];
  try {
    await a.returned("claimMany", 1);
    await b.returned("claimMany", 1);
    assert.deepEqual(record.claims.map(({ epoch }) => epoch), [1], JSON.stringify(record.claims));
    const [holder, other] = record.claims[0].runner === "runner-a" ? [runners[0], runners[1]] : [runners[1], runners[0]];
    const otherTold = other === runners[0] ? a : b;
    // One poll interval: the holder's loop commits a turn, and the other runner polls once more, finding nothing.
    t.mock.timers.tick(TIMING.pollMs);
    await committed((commits) => commits.some((commit) => commit.epoch === 1));
    await otherTold.returned("claimMany", 2);
    holder.kill();
    const lastUntil = (await server.runs.get("run-1")).claimedUntil;

    // One poll at a time until the other runner claims the run: never while the clock is at or before claimed_until.
    let polls = otherTold.count("claimMany");
    const limit = polls + LEASE_MS / TIMING.pollMs + 5;
    while (record.claims.length < 2) {
      assert.ok(polls < limit, `the other runner reclaims within ${limit} polls: ${JSON.stringify(record.claims)}`);
      t.mock.timers.tick(TIMING.pollMs);
      await otherTold.returned("claimMany", ++polls);
      if (record.claims.length < 2) continue;
      assert.ok(Date.now() > lastUntil, `reclaimed only past claimed_until: at ${Date.now()}, until ${lastUntil}`);
    }
    const second = record.claims[1];
    assert.deepEqual([second.runner, second.epoch], [other.name, 2]);
    assert.ok(second.at > lastUntil, `the reclaim's time ${second.at} is past claimed_until ${lastUntil}`);

    const dead = faux.loops.find((loop) => loop.claim.epoch === 1);
    await assert.rejects(dead.commitNow(), { name: "Fenced" }, "the dead runner's late commit");
    assert.equal(record.commits.filter((commit) => commit.epoch === 1 && commit.startedAt > second.at).length, 0, "nothing of epoch 1 lands after the reclaim");
    // One turn of the new holder's loop.
    t.mock.timers.tick(TIMING.pollMs);
    await committed((commits) => commits.some((commit) => commit.epoch === 2));
  } finally {
    t.mock.timers.reset();
    await Promise.all(runners.map((runner) => runner.close()));
  }
});

test("a runner that closes stops its loop where it can resume and releases the run, still running; the other claims it at once", async (t) => {
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  // Its point is a close's early release, never a lapse: the steady lease (its "before the old lease ran out" holds
  // only more plainly on it).
  const { server, record, runners: [a, b] } = await twoRunners(t, faux.createLoop, STEADY);
  await queue(server, "run-1");

  const first = await until(() => record.claims[0], "a claim");
  const holder = first.runner === a.name ? a : b;
  const other = holder === a ? b : a;
  const leaseEnd = (await server.runs.get("run-1")).claimedUntil;
  await holder.close();
  const closedAt = Date.now();

  assert.equal(faux.loops[0].stopCalls[0]?.kind, "shutdown", "the loop is stopped for a shutdown");
  assert.match(record.ops.join(" | "), /flush \| release run-1/, "flushed, then released");
  // The other runner's next poll claims it: waited for by that claim, the bound only capping the wait (30 s, far past any
  // poll a loaded box could delay), so a runner that never reclaims fails the case in words, never hangs it.
  const second = await until(() => record.claims[1], "the other runner's claim of the released run (its next poll)", EVENT_WAIT_MS);
  // The close's release bumped the epoch to 2: the other runner's claim is 3.
  assert.deepEqual([second.runner, second.epoch], [other.name, 3]);
  assert.ok(second.at < leaseEnd, `claimed ${second.at - closedAt} ms after the close, before the old lease would have run out`);
  // The claim is recorded as the store returns it, the new loop made only once the runner's own call resumes: waited for.
  const resumed = await until(() => faux.loops[1]?.claim && faux.loops[1], "the other runner's loop, started on its claim", EVENT_WAIT_MS);
  assert.equal(resumed.claim.epoch, 3, "a new loop resumes it");
});

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
