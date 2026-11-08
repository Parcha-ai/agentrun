// The store's claim is the one fence for a run (design 2.1 and "the claim epoch is the one fence"): a claim moves the
// run's epoch up by one, and every write a runner makes for the run carries the epoch it holds. A write under a stale
// epoch is refused (Fenced) and writes nothing. A claim that ran out (claimed_until passed) is taken by the next claimer,
// and of two claimers at once exactly one wins. Times are epoch ms.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Fenced } from "../dist/store/store.js";
import { queued, storeOn } from "./store-helpers.mjs";

test("a claim moves the run's epoch up by one and holds it running until claimed_until", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  assert.deepEqual(await store.runs.get("run-1").then((run) => [run.state, run.epoch, run.runner]), ["queued", 0, null]);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  assert.deepEqual(claim, { runId: "run-1", runner: "runner-a", epoch: 1, until: clock.now + 30_000, from: "queued" });
  const run = await store.runs.get("run-1");
  assert.deepEqual([run.state, run.epoch, run.runner, run.claimedUntil], ["running", 1, "runner-a", clock.now + 30_000]);
  assert.equal(await store.claim("run-1", "runner-b", { leaseMs: 30_000 }), null, "a live claim is not taken");
});

test("a run update under a stale epoch is refused (Fenced) and writes nothing", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const first = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 2_000;
  const second = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.equal(second?.epoch, 2, "the run out claim is taken");
  const before = await store.runs.get("run-1");
  await assert.rejects(store.runs.update(first, { state: "ended", costUsd: 1.5, summary: "done by the stale runner" }), (error) => error instanceof Fenced && error.runId === "run-1" && error.epoch === 1);
  assert.deepEqual(await store.runs.get("run-1"), before, "the refused update wrote nothing");
  await assert.rejects(store.renew(first, { leaseMs: 30_000 }), Fenced, "nor does a stale renew");
  await assert.rejects(store.release(first), Fenced, "nor a stale release");
  assert.deepEqual(await store.runs.get("run-1"), before);
  await store.runs.update(second, { state: "ended", costUsd: 0.25, summary: "done" });
  assert.deepEqual(await store.runs.get("run-1").then((run) => [run.state, run.costUsd, run.summary, run.epoch, run.endedAt]), ["ended", 0.25, "done", 2, clock.now]);
});

test("an expired claim is reclaimed by the next claimer, and the holder's renew before it runs out keeps it", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const held = await store.claim("run-1", "runner-a", { leaseMs: 10_000 });
  clock.now += 8_000;
  const renewed = await store.renew(held, { leaseMs: 10_000 });
  assert.deepEqual([renewed.epoch, renewed.until], [1, clock.now + 10_000], "a renew keeps the epoch");
  clock.now += 8_000;
  assert.equal(await store.claim("run-1", "runner-b", { leaseMs: 10_000 }), null, "renewed, it has not run out");
  clock.now += 3_000;
  const taken = await store.claim("run-1", "runner-b", { leaseMs: 10_000 });
  assert.deepEqual([taken?.epoch, taken?.runner], [2, "runner-b"], "run out, it is reclaimed");
});

test("two claimers at once on one queued run: exactly one wins", async (t) => {
  const { store, file, clock } = await storeOn(t);
  await queued(store);
  // A runner process's store on the same file (one connection per process).
  const { store: other } = await storeOn(t, { clock, file, role: "runner" });
  const claims = await Promise.all([store.claim("run-1", "runner-a", { leaseMs: 30_000 }), other.claim("run-1", "runner-b", { leaseMs: 30_000 })]);
  assert.equal(claims.filter(Boolean).length, 1, JSON.stringify(claims));
  assert.equal(claims.find(Boolean).epoch, 1);
  assert.equal((await store.runs.get("run-1")).runner, claims.find(Boolean).runner);
});

test("a release at a park gives the run back with its state and wake_at; an ended run is never claimed", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.release(claim, { state: "parked", wakeAt: clock.now + 60_000 });
  const run = await store.runs.get("run-1");
  assert.deepEqual([run.state, run.runner, run.claimedUntil, run.wakeAt, run.epoch], ["parked", null, null, clock.now + 60_000, 1]);
  assert.equal(await store.claim("run-1", "runner-b", { leaseMs: 30_000 }), null, "parked with nothing to wake it: not claimable");
  clock.now += 60_000;
  const again = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.deepEqual([again?.epoch, (await store.runs.get("run-1")).state], [2, "running"], "its wake_at passed: claimed, running");
  await store.release(again, { state: "ended" });
  assert.deepEqual(await store.runs.get("run-1").then((r) => [r.state, r.wakeAt, r.endedAt]), ["ended", null, clock.now], "a release with no wakeAt clears it");
  assert.equal(await store.claim("run-1", "runner-c", { leaseMs: 30_000 }), null, "an ended run is final");
});
