// A claim or a renew that waits in line before it takes the store's writer lock (another write holds it, or this
// runner's own connection is busy with the calls before it) is granted its lease from the lock, on the store's clock: the
// row's claimed_until is the lock's time plus the lease. When that clock is this process's own (SQLite, or a store whose
// clock a test moves), the runner holds the claim until that claimed_until less its stop margin, and never loses it
// sooner because the ask waited. The fence stays: with no later renew landing, the loop is stopped at claimed_until less
// the margin, before the store's lease runs out and another runner may claim the run.
//
// One clock for all of it (fakeClock): the store's (stores' `time`) and the runner's claim deadline. The wait in line is
// a held promise in front of the store's call while the test moves the clock, never a wall-clock wait.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fakeClock, fauxLoops, observed, queue, recorder, stores, until } from "./runner-support.mjs";

const LEASE_MS = 60_000;
const MARGIN_MS = 5_000;
// The renew tick is wall-clock: long here, so no renew runs unless a case asks for one.
const TIMING = { leaseMs: LEASE_MS, stopMarginMs: MARGIN_MS, renewEveryMs: 20_000, pollMs: 20, commandPollMs: 20 };
const WAIT_MS = 10_000;

/** A gate a store call waits at: `entered` once a call reached it, `open()` lets it through. */
function gate() {
  let enter;
  let open;
  const entered = new Promise((resolve) => (enter = resolve));
  const opened = new Promise((resolve) => (open = resolve));
  return { entered, open, pass: async () => (enter(), await opened) };
}

/** The runner's store: the observed runner store, with the store's own lease clock, and `wrap` over its calls. */
function runnerStore(raw, record, wrap) {
  const base = observed(raw, record);
  return wrap({ ...base, leaseClock: raw.leaseClock });
}

async function start(t, clock, store, timing = {}) {
  const faux = fauxLoops({ turns: 10_000, turnMs: 20 });
  const events = [];
  const runner = startRunner({ store, createLoop: faux.createLoop, name: "runner-a", clock, onEvent: (event) => events.push({ ...event, clockAt: clock.now() }), ...TIMING, ...timing });
  t.after(() => runner.close());
  return { faux, events, runner };
}

const lost = (events) => events.filter((event) => event.type === "claim-lost");

test("a claim that waited in line longer than its lease less the margin holds the run from the store's lock, until its claimed_until less the margin", async (t) => {
  const clock = fakeClock();
  const opened = await stores({ runners: 1, time: clock.now });
  const record = recorder();
  const inLine = gate();
  const store = runnerStore(opened.runners[0], record, (base) => ({
    ...base,
    runs: {
      ...base.runs,
      // The first claim waits in line; the polls after it go straight through.
      async claimMany(...args) {
        await inLine.pass();
        return base.runs.claimMany(...args);
      },
    },
  }));
  await queue(opened.server, "run-1");
  const { events } = await start(t, clock, store);

  // The claim is asked, then waits in line 56 s on the store's clock: past the 55 s its lease less the margin spans from
  // the ask. It takes the lock then, and the store grants it 60 s from there.
  await inLine.entered;
  const askedAt = clock.now();
  clock.advance(LEASE_MS - MARGIN_MS + 1_000);
  inLine.open();
  await until(() => record.commits.some((commit) => commit.epoch === 1), "the loop commits under its claim", WAIT_MS);
  const until_ = (await opened.server.runs.get("run-1")).claimedUntil;
  assert.equal(until_, askedAt + LEASE_MS - MARGIN_MS + 1_000 + LEASE_MS, "the store's lease runs from the lock");

  // A deadline counted from the ask would be due already, and fire at the clock's next move.
  clock.advance(1);
  assert.deepEqual(lost(events), [], "the claim the store just granted is held");

  // No renew lands (the tick is long): the loop is stopped at claimed_until less the margin, on the store's clock.
  clock.advance(until_ - MARGIN_MS - clock.now() - 1);
  assert.deepEqual(lost(events), [], "held up to its claimed_until less the margin");
  clock.advance(1);
  const [loss] = await until(() => lost(events).length > 0 && lost(events), "the claim is lost at its claimed_until less the margin", WAIT_MS);
  assert.equal(loss.why, "not-renewed");
  assert.equal(loss.epoch, 1);
  assert.equal(loss.clockAt, until_ - MARGIN_MS, "stopped the margin before the store's lease runs out");
});

test("a renew that waited in line holds the run from its own lock: a deadline counted from its ask is not the one kept", async (t) => {
  const clock = fakeClock();
  const opened = await stores({ runners: 1, time: clock.now });
  const record = recorder();
  const inLine = gate();
  let renews = 0;
  let answered = false;
  // The renews after the first never reach the store: only the first one's answer moves the claim.
  let cut;
  const never = new Promise((_, reject) => (cut = reject));
  never.catch(() => undefined);
  t.after(() => cut(new Error("the test is over")));
  const store = runnerStore(opened.runners[0], record, (base) => ({
    ...base,
    async renewMany(claims, options) {
      renews += 1;
      if (renews > 1) return never;
      await inLine.pass();
      const answer = await base.renewMany(claims, options);
      answered = true;
      return answer;
    },
  }));
  await queue(opened.server, "run-1");
  const { events } = await start(t, clock, store, { renewEveryMs: 100 });
  await until(() => record.commits.some((commit) => commit.epoch === 1), "the loop commits under its claim", WAIT_MS);
  const claimedAt = (await opened.server.runs.get("run-1")).claimedUntil - LEASE_MS;

  // A renew tick (wall-clock, short here): the renew is asked now, and waits in line 50 s, inside the claim's 55 s.
  await inLine.entered;
  const askedAt = clock.now();
  clock.advance(50_000);
  inLine.open();
  await until(() => answered, "the renew is answered", WAIT_MS);
  const until_ = (await opened.server.runs.get("run-1")).claimedUntil;
  assert.equal(until_, askedAt + 50_000 + LEASE_MS, "the store's lease runs from the renew's lock");
  assert.ok(claimedAt <= askedAt);

  // Past the ask's 55 s, and the claim's: the renew's lease holds it.
  clock.advance(askedAt + LEASE_MS - MARGIN_MS + 1_000 - clock.now());
  assert.deepEqual(lost(events), [], "held by the renew that landed");

  clock.advance(until_ - MARGIN_MS - clock.now() - 1);
  assert.deepEqual(lost(events), [], "held up to the renew's claimed_until less the margin");
  clock.advance(1);
  const [loss] = await until(() => lost(events).length > 0 && lost(events), "the claim is lost at the renew's claimed_until less the margin", WAIT_MS);
  assert.equal(loss.why, "not-renewed");
  assert.equal(loss.clockAt, until_ - MARGIN_MS, "stopped the margin before the store's lease runs out");
});
