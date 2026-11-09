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

test("the holder is killed: the other reclaims after claimed_until with epoch 2, and the dead one's late commit is Fenced", async (t) => {
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const { server, record, runners: [a, b] } = await twoRunners(t, faux.createLoop);
  await queue(server, "run-1");

  const first = await until(() => record.claims[0], "a claim");
  const holder = first.runner === a.name ? a : b;
  const other = holder === a ? b : a;
  await until(() => record.commits.some((commit) => commit.epoch === 1), "the holder's loop commits");
  holder.kill();
  const killedAt = Date.now();
  const lastUntil = (await server.runs.get("run-1")).claimedUntil;

  const second = await until(() => record.claims[1], "the reclaim", LEASE_MS * 10);
  assert.deepEqual([second.runner, second.epoch], [other.name, 2]);
  assert.ok(second.at > lastUntil, `reclaimed at ${second.at - killedAt} ms after the kill, before claimed_until (${lastUntil - killedAt} ms)`);

  const dead = faux.loops.find((loop) => loop.claim.epoch === 1);
  await assert.rejects(dead.commitNow(), { name: "Fenced" }, "the dead runner's late commit");
  assert.equal(record.commits.filter((commit) => commit.epoch === 1 && commit.startedAt > second.at).length, 0, "nothing of epoch 1 lands after the reclaim");
  await until(() => record.commits.some((commit) => commit.epoch === 2), "the new holder's loop commits");
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
  // A starved machine as the close goes: close() has stopped the loop, then the process blocks 600 ms (no renew runs), so
  // a lease shorter than the stall runs out before the close's release, and the runner lets the claim go unreleased.
  const closing = holder.close();
  const until600 = Date.now() + 600;
  while (Date.now() < until600);
  await closing;
  const closedAt = Date.now();

  assert.equal(faux.loops[0].stopCalls[0]?.kind, "shutdown", "the loop is stopped for a shutdown");
  assert.match(record.ops.join(" | "), /flush \| release run-1/, "flushed, then released");
  const second = await until(() => record.claims[1], "the other runner's claim", LEASE_MS * 10);
  // The close's release bumped the epoch to 2: the other runner's claim is 3.
  assert.deepEqual([second.runner, second.epoch], [other.name, 3]);
  assert.ok(second.at < leaseEnd, `claimed ${second.at - closedAt} ms after the close, before the old lease would have run out`);
  assert.equal(faux.loops[1].claim.epoch, 3, "a new loop resumes it");
});

test("a run that ends is flushed and released, and never claimed again", async (t) => {
  const faux = fauxLoops({ turns: 2, turnMs: 10 });
  const { server, record, events, runners } = await twoRunners(t, faux.createLoop);
  // A slow flush, as on a loaded machine: the end commit already reads released on the row, so only the runner's own
  // "released" says the flush and the release are done.
  record.flushDelayMs = 150;
  await queue(server, "run-1");

  await until(() => events.some((event) => event.type === "released" && event.runId === "run-1"), "the runner says released");
  assert.equal((await server.runs.get("run-1")).runner, null, "the end commit released the row");
  assert.match(record.ops.join(" | "), /ended run-1 \| flush \| release run-1/, "the end commit, then a flush, then the release");
  const run = await server.runs.get("run-1");
  assert.ok(run.endedAt !== null, "the end commit stamped ended_at");
  await sleep(LEASE_MS);
  assert.equal(record.claims.length, 1, "an ended run is final");
  assert.deepEqual(runners.flatMap((runner) => runner.held()), [], "no runner holds it");
  assert.deepEqual(await server.runs.claimable({ limit: 10 }), []);
});
