// The runs a runner may claim (runs.claimable), oldest first, in one query: queued; parked with an untaken command row or
// its wake_at passed (a parked run holds no claim: its runner flushed and released it at the park); running with its claim
// run out. Never a final run, a live claim, or a parked run with nothing to wake it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

test("a parked run is not claimable until a command row lands, and then it is", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.release(claim, { state: "parked" });
  assert.deepEqual(await store.runs.claimable(), [], "parked, no command: not claimable");
  const command = await store.command("run-1", { kind: "approve", body: { approval: "a1" } });
  assert.deepEqual(await store.runs.claimable(), ["run-1"], "an untaken command makes it claimable");
  const again = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.equal(again?.epoch, 3, "the release moved the epoch on, and the claim once more");
  await store.take(again, command.id);
  await store.release(again, { state: "parked" });
  assert.deepEqual(await store.runs.claimable(), [], "the command taken: parked again, not claimable");
});

test("a run parked while its runner still holds the claim is not claimable, even with a command row, until that claim is released or runs out", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  // The ask's commit parks the run while its runner holds the claim; the release comes a few seconds later.
  await store.runs.update(claim, { state: "parked" });
  await store.command("run-1", { kind: "approve", body: { approval: "a1" } });
  assert.deepEqual(await store.runs.claimable(), [], "parked under a held claim: not claimable, whatever its rows");
  assert.equal(await store.claim("run-1", "runner-b", { leaseMs: 30_000 }), null, "another runner cannot claim it");
  clock.now += 30_001;
  assert.deepEqual(await store.runs.claimable(), ["run-1"], "once the held claim runs out, the command row wakes it");
});

test("a running run released with a backoff is not claimable until the backoff passes", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.release(claim, { backoffUntil: clock.now + 5_000 });
  assert.equal((await store.runs.get("run-1")).state, "running");
  assert.deepEqual(await store.runs.claimable(), [], "backing off: not claimable");
  clock.now += 4_999;
  assert.deepEqual(await store.runs.claimable(), [], "a ms before it");
  clock.now += 1;
  assert.deepEqual(await store.runs.claimable(), ["run-1"], "at it");
});

test("a parked run's wake_at: in the future it is not claimable; once the clock passes it, it is", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.release(claim, { state: "parked", wakeAt: clock.now + 5_000 });
  assert.deepEqual(await store.runs.claimable(), []);
  clock.now += 4_999;
  assert.deepEqual(await store.runs.claimable(), [], "a ms before it");
  clock.now += 1;
  assert.deepEqual(await store.runs.claimable(), ["run-1"], "at it");
});

test("a running run its runner released without ending it (a runner's shutdown) stays running and is claimable at once, at epoch + 1", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.release(claim);
  const run = await store.runs.get("run-1");
  assert.deepEqual([run.state, run.runner, run.claimedUntil], ["running", null, null], "it started: it never goes back to queued");
  assert.deepEqual(await store.runs.claimable(), ["run-1"], "claimable with no wait for the lease it gave up");
  const next = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  assert.deepEqual([next?.epoch, next?.runner], [3, "runner-b"], "the release moved the epoch to 2; the next claim takes 3");
});

test("queued runs and running runs whose claim ran out are claimable, oldest first, within the limit; live claims and final runs are not", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const id of ["run-a", "run-b", "run-c", "run-d", "run-e"]) {
    await queued(store, id);
    clock.now += 1_000;
  }
  const live = await store.claim("run-b", "runner-a", { leaseMs: 60_000 });
  const lapsing = await store.claim("run-c", "runner-a", { leaseMs: 1_000 });
  const ending = await store.claim("run-d", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(ending, { state: "ended" });
  assert.ok(live && lapsing);
  assert.deepEqual(await store.runs.claimable(), ["run-a", "run-e"], "queued ones, oldest first");
  clock.now += 2_000;
  assert.deepEqual(await store.runs.claimable(), ["run-a", "run-c", "run-e"], "run-c's claim ran out");
  assert.deepEqual(await store.runs.claimable({ limit: 2 }), ["run-a", "run-c"], "within the limit");
});
