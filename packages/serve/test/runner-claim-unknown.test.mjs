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
  // The order is driven by the runner's own calls, never by a timer: the claim's commit is answered Unanswered with
  // nothing landed; the sweep's first read-back finds nothing; only once that read has returned does the commit land
  // (before the runner sees the read's answer); a later pass must then find it and give it back.
  let commit; // the first claimMany's arguments, held until the commit lands
  let landed; // the late commit's claims, once landed
  const reads = [];
  const wrapped = {
    ...store,
    runs: {
      ...store.runs,
      async claimMany(runner, k, options) {
        if (!commit) {
          commit = { runner, k, options };
          throw unanswered();
        }
        // Polls before the commit landed find nothing to claim: the pending commit holds the run.
        if (!landed) return [];
        return store.runs.claimMany(runner, k, options);
      },
      async claimsOf(runner) {
        const held = await store.runs.claimsOf(runner);
        reads.push(held.map((claim) => claim.epoch));
        if (commit && !landed) landed = await store.runs.claimMany(commit.runner, commit.k, commit.options);
        return held;
      },
    },
  };
  const events = [];
  let ended;
  const end = new Promise((resolve) => (ended = resolve));
  const runner = startRunner({
    store: wrapped,
    createLoop: faux.createLoop,
    name: "runner-a",
    onEvent: (event) => {
      events.push(event);
      if (event.type === "released" && event.runId === "run-1" && event.end === "ended") ended(event);
    },
    ...TIMING,
  });
  t.after(() => runner.close());
  // No short wall-clock bound: the lease (60 s) is twice the test's own timeout, so a run that ends at all was given back
  // by a pass, never by the lease running out. The 25 s guard only names what a run that never ends means.
  let guard;
  const ran = await Promise.race([end.then(() => true), new Promise((resolve) => (guard = setTimeout(() => resolve(false), 25_000)))]);
  clearTimeout(guard);
  assert.ok(ran, `run-1 was never given back by a later pass: held at epoch 1 until the lease (reads ${JSON.stringify(reads)}, landed ${JSON.stringify(landed?.map((claim) => claim.epoch))})`);
  const run = await server.runs.get("run-1");
  assert.deepEqual(reads[0], [], "the first read-back ran before the commit landed and found nothing");
  assert.deepEqual(landed?.map((claim) => claim.epoch), [1], "the late commit landed the claim at epoch 1");
  assert.ok(reads.slice(1).some((epochs) => epochs.includes(1)), `a later pass read the landed claim back: ${JSON.stringify(reads)}`);
  assert.ok(events.some((event) => event.type === "error" && event.step === "claim" && /given back/.test(event.message) && /epoch 1/.test(event.message)), JSON.stringify(events.filter((event) => event.type === "error")));
  assert.equal(run.state, "ended");
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

test("a close with a busy run and a claim recovery in flight drains from the close's start: the recovery shares the drain and the close's window, never adding a window of its own", { timeout: 30_000 }, async (t) => {
  // A turn far longer than the drain: the drain runs to its bound, and the shutdown's stop ends the turn at once.
  const faux = fauxLoops({ turns: 2, turnMs: 20_000 });
  const { server, runners: [one] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const store = observed(one, recorder());
  let claims = 0;
  const wrapped = {
    ...store,
    runs: {
      ...store.runs,
      // The first claim (run-1) lands; every later one is answered Unanswered, and its read-back never answers.
      async claimMany(runner, k, options) {
        if (claims++ === 0) return store.runs.claimMany(runner, k, options);
        throw unanswered();
      },
      claimsOf: () => new Promise(() => {}),
    },
  };
  const leaseMs = 3_000;
  const stopMarginMs = 500;
  const drainMs = 1_000;
  const runner = startRunner({ store: wrapped, createLoop: faux.createLoop, name: "runner-a", ...TIMING, leaseMs, renewEveryMs: 500, stopMarginMs, drainMs });
  t.after(() => runner.close());
  await until(() => faux.loops[0]?.claim, "run-1 held");
  // run-2 is queued: the next poll's claim is answered Unanswered and its recovery's read never answers.
  await queue(server, "run-2");
  await until(() => claims >= 2, "a claim in recovery");
  const started = Date.now();
  await runner.close();
  const took = Date.now() - started;
  const [stop] = faux.loops[0].stopCalls;
  assert.equal(stop?.kind, "shutdown");
  // The drain is counted from the close's start, not from the end of a wait for the claim in flight.
  assert.ok(stop.at - started < drainMs + 400, `run-1 was stopped ${stop.at - started} ms into the close, its drain is ${drainMs} ms`);
  // The claim in flight is waited for inside the close's window (the lease less its margin), not after the drain.
  assert.ok(took < leaseMs - stopMarginMs + 400, `close took ${took} ms, its window is ${leaseMs - stopMarginMs} ms`);
});

test("a close with a claim in flight resolves only once that claim has landed and been given back: the runner holds nothing after its close", { timeout: 30_000 }, async (t) => {
  const faux = fauxLoops({ turns: 2, turnMs: 5 });
  const { server, runners: [one] } = await stores({ runners: 1 });
  const store = observed(one, recorder());
  let land;
  const landing = new Promise((resolve) => (land = resolve));
  let asked = false;
  const wrapped = {
    ...store,
    runs: {
      ...store.runs,
      // The claim is in flight until the case lets it land: the store answers late.
      async claimMany(runner, k, options) {
        asked = true;
        await landing;
        return store.runs.claimMany(runner, k, options);
      },
    },
  };
  const runner = startRunner({ store: wrapped, createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await queue(server, "run-1");
  await until(() => asked, "a claim in flight");
  let closed = false;
  const closing = runner.close().then(() => (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(closed, false, "close resolved with a claim still in flight");
  land();
  await closing;
  const run = await server.runs.get("run-1");
  assert.equal(run.runner, null, "the claim that landed as the runner closed was given back");
  assert.equal(faux.loops.length, 0, "no loop started on it");
});
