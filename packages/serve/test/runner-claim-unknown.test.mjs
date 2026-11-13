// A claim or release commit answered Unanswered (the store's Postgres did not answer within its bound) may have landed.
// Before this, the runner logged the error and went on: a claim that had landed held the run under that runner with no
// loop on it until the steady lease (10 minutes) ran out. Now the runner reads back what it holds, releases a claim of its
// own that nothing here holds (fenced on its epoch), and a release that may not have landed is read back and repeated.
// Each case lands the commit and then throws, with a lease far longer than the test's wait, so a run worked or released in
// time was worked or released by the read-back, never by the lease running out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxLoops, observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { Unanswered } = await import("../dist/store/index.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 20, unknownBackoffMs: 10 };
const unanswered = () => new Unanswered("its commit", 8_000);

/** `store` as the runner sees it, with `claimMany` landing and then throwing Unanswered the first `claimLandsThenThrows`
 *  times, `claimsOf` failing the first `readFails` times, and `release` landing (or not: `releaseLands`) and throwing
 *  Unanswered the first `releaseThrows` times. */
function flaky(store, { claimLandsThenThrows = 0, readFails = 0, releaseThrows = 0, releaseLands = true } = {}) {
  const left = { claim: claimLandsThenThrows, read: readFails, release: releaseThrows };
  const seen = { claims: [], releases: 0 };
  return {
    seen,
    store: {
      ...store,
      runs: {
        ...store.runs,
        async claimMany(runner, k, options) {
          const claims = await store.runs.claimMany(runner, k, options);
          seen.claims.push(...claims.map((claim) => claim.epoch));
          if (claims.length && left.claim-- > 0) throw unanswered();
          return claims;
        },
        async claimsOf(runner) {
          if (left.read-- > 0) throw unanswered();
          return store.runs.claimsOf(runner);
        },
      },
      async release(claim, options) {
        seen.releases += 1;
        if (left.release-- > 0) {
          if (releaseLands) await store.release(claim, options);
          throw unanswered();
        }
        return store.release(claim, options);
      },
    },
  };
}

async function runWith(t, options, loopOptions = { turns: 2, turnMs: 5 }) {
  const faux = fauxLoops(loopOptions);
  const { server, runners: [one] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const record = recorder();
  const wrapped = flaky(observed(one, record), options);
  const events = [];
  const runner = startRunner({ store: wrapped.store, createLoop: faux.createLoop, name: "runner-a", onEvent: (event) => events.push(event), ...TIMING });
  t.after(() => runner.close());
  return { server, wrapped, events, faux };
}

test("a claim that landed and was answered Unanswered is given back at once, and the run is worked well within the lease", { timeout: 30_000 }, async (t) => {
  const { server, wrapped, events } = await runWith(t, { claimLandsThenThrows: 1 });
  const run = await until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "ended" ? row : undefined;
  }, `run-1 ended well within the ${STEADY_LEASE.leaseMs} ms lease`, 10_000);
  assert.equal(run.state, "ended");
  assert.ok(run.epoch >= 2, `the first claim (epoch 1) was given back and the run taken again: epoch ${run.epoch}`);
  assert.deepEqual(wrapped.seen.claims.slice(0, 1), [1]);
  assert.ok(events.some((event) => event.type === "error" && event.step === "claim" && /given back/.test(event.message)), JSON.stringify(events.filter((event) => event.type === "error")));
});

test("the read-back that itself fails is retried with a backoff, then the run is given back", { timeout: 30_000 }, async (t) => {
  const { server } = await runWith(t, { claimLandsThenThrows: 1, readFails: 2 });
  const run = await until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "ended" ? row : undefined;
  }, "run-1 ended well within the lease", 10_000);
  assert.ok(run.epoch >= 2);
});

test("a release that landed and was answered Unanswered is read back and not repeated", { timeout: 30_000 }, async (t) => {
  const { server, wrapped, events } = await runWith(t, { releaseThrows: 1, releaseLands: true }, { turns: 1, turnMs: 5, park: true });
  await until(() => events.some((event) => event.type === "released"), "its release reported", 10_000);
  assert.equal(wrapped.seen.releases, 1, "the release had landed: read back, not sent again");
  assert.equal((await server.runs.get("run-1")).runner, null);
});

test("a release that did not land and was answered Unanswered is read back and sent again, not left to the lease", { timeout: 30_000 }, async (t) => {
  const { server, wrapped } = await runWith(t, { releaseThrows: 1, releaseLands: false }, { turns: 1, turnMs: 5, park: true });
  await until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "parked" && row.runner === null;
  }, `run-1 released well within the ${STEADY_LEASE.leaseMs} ms lease`, 10_000);
  assert.equal(wrapped.seen.releases, 2, "sent again once");
});

test("a commit answered Unanswered that lands after the first read-back is still given back by a later pass", { timeout: 30_000 }, async (t) => {
  const faux = fauxLoops({ turns: 2, turnMs: 5 });
  const { server, runners: [one] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const store = observed(one, recorder());
  let late = 0;
  const wrapped = {
    ...store,
    runs: {
      ...store.runs,
      async claimMany(runner, k, options) {
        // Answered Unanswered with nothing landed yet: the commit lands 100 ms later, after the first read-back. Polls
        // between find nothing to claim (the pending commit holds the run); once it landed, claims are real again.
        if (late === 0) {
          late = -1;
          setTimeout(() => {
            void store.runs.claimMany(runner, k, options).then(() => (late = -2));
          }, 100);
          throw unanswered();
        }
        if (late === -1) return [];
        return store.runs.claimMany(runner, k, options);
      },
    },
  };
  const events = [];
  const runner = startRunner({ store: wrapped, createLoop: faux.createLoop, name: "runner-a", onEvent: (event) => events.push(event), ...TIMING });
  t.after(() => runner.close());
  const run = await until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "ended" ? row : undefined;
  }, `run-1 ended in 3 s, long before the ${STEADY_LEASE.leaseMs} ms lease`, 3_000);
  assert.ok(run.epoch >= 2, `the late claim was given back and the run taken again: epoch ${run.epoch}`);
});

test("a claim ending a stopped queued run is not given back by a later poll's Unanswered sweep", { timeout: 30_000 }, async (t) => {
  const faux = fauxLoops({ turns: 2, turnMs: 5 });
  const { server, runners: [one] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  await server.command("run-1", { kind: "stop" });
  const store = observed(one, recorder());
  let calls = 0;
  const wrapped = {
    ...store,
    runs: {
      ...store.runs,
      // The ending's own read, held so the next poll's sweep runs between the stop's writes.
      async launch(runId) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return store.runs.launch?.(runId);
      },
      async claimMany(runner, k, options) {
        if (calls++ === 0) return store.runs.claimMany(runner, k, options);
        throw unanswered();
      },
    },
  };
  const events = [];
  const runner = startRunner({ store: wrapped, createLoop: faux.createLoop, name: "runner-a", onEvent: (event) => events.push(event), ...TIMING });
  t.after(() => runner.close());
  const run = await until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "stopped" && row.runner === null ? row : undefined;
  }, "run-1 stopped by its own ending claim", 10_000);
  assert.equal(run.summary, "stopped by a person");
  assert.ok(!events.some((event) => event.type === "error" && event.step === "end (fenced)"), "no write of the ending was fenced");
  assert.ok(!events.some((event) => event.type === "error" && event.step === "claim" && /given back/.test(event.message)), JSON.stringify(events.filter((event) => event.type === "error")));
});

test("a close during a claim recovery whose read-back never answers is held no longer than the close's window", { timeout: 30_000 }, async (t) => {
  const faux = fauxLoops({ turns: 2, turnMs: 5 });
  const { runners: [one] } = await stores({ runners: 1 });
  const store = observed(one, recorder());
  const wrapped = {
    ...store,
    runs: {
      ...store.runs,
      async claimMany() {
        throw unanswered();
      },
      // The store's Postgres never answers the read.
      claimsOf: () => new Promise(() => {}),
    },
  };
  const runner = startRunner({ store: wrapped, createLoop: faux.createLoop, name: "runner-a", ...TIMING, leaseMs: 1_500, renewEveryMs: 500, stopMarginMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  const closed = await Promise.race([runner.close().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  assert.ok(closed, "close resolved while the recovery's read never answered");
  assert.ok(Date.now() - started < 3_000, `close took ${Date.now() - started} ms, the window is 1000 ms`);
});
