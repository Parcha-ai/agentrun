// A parked run woken by a command (a raise) whose resume fails stays parked: the runner counts the try on the command
// (retry, fenced, the command left untaken), backs off (release with backoffUntil), and after its last try refuses the
// command with why. A claim says what the run was before it (from). A parked run is claimable on an untaken command once
// its backoff has passed (or it has none), on an untaken stop at any time, or once its wake_at passes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Fenced } from "../dist/store/store.js";
import { queued, storeOn } from "./store-helpers.mjs";

test("a claim says what the run was before it: queued, parked (woken by a command), running (released, or its claim lapsed)", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const first = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  assert.equal(first?.from, "queued");
  clock.now += 2_000;
  const lapsed = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.equal(lapsed?.from, "running", "its claim lapsed");
  await store.release(lapsed, { state: "parked" });
  await store.command("run-1", { kind: "raise", body: { usd: 5 } });
  const woken = await store.claim("run-1", "runner-c", { leaseMs: 30_000 });
  assert.equal(woken?.from, "parked");
  await store.release(woken);
  const released = await store.claim("run-1", "runner-d", { leaseMs: 30_000 });
  assert.equal(released?.from, "running", "released without ending it");
});

test("retry counts a failed resume on its command under the claim, leaving it untaken; a stale claim's retry is Fenced; after the last try take refuses it with why, and the run stays parked", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const parkClaim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.release(parkClaim, { state: "parked" });
  const raise = await store.command("run-1", { kind: "raise", body: { usd: 5 } });
  const tryOne = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  assert.equal(await store.retry(tryOne, raise.id), 1);
  const [one] = await store.commands("run-1", 0);
  assert.deepEqual([one.tries, one.takenAt, one.refused], [1, null, null], "counted, still untaken");
  clock.now += 2_000;
  const tryTwo = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  await assert.rejects(store.retry(tryOne, raise.id), Fenced, "a stale claim counts nothing");
  assert.equal(await store.retry(tryTwo, raise.id), 2);
  await store.take(tryTwo, raise.id, "refused", "the run could not start again after 2 tries");
  await store.release(tryTwo, { state: "parked" });
  const [two] = await store.commands("run-1", 0);
  assert.deepEqual([two.tries, two.takenAt, two.refused], [2, clock.now, "the run could not start again after 2 tries"]);
  assert.equal((await store.runs.get("run-1")).state, "parked", "never failed");
  assert.deepEqual(await store.runs.claimable(), [], "nothing left to wake it");
});

test("a parked run in backoff is not claimable on its untaken command until backoff_until; a stop sent during the backoff makes it claimable at once; a claim clears the backoff", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const parkClaim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.release(parkClaim, { state: "parked" });
  const raise = await store.command("run-1", { kind: "raise", body: { usd: 5 } });
  const failed = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.retry(failed, raise.id);
  await store.release(failed, { state: "parked", backoffUntil: clock.now + 10_000 });
  assert.equal((await store.runs.get("run-1")).backoffUntil, clock.now + 10_000);
  assert.deepEqual(await store.runs.claimable(), [], "the untaken raise waits out the backoff");
  assert.equal(await store.claim("run-1", "runner-b", { leaseMs: 30_000 }), null);
  clock.now += 10_000;
  assert.deepEqual(await store.runs.claimable(), ["run-1"], "at backoff_until it is claimable again");
  const again = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.equal((await store.runs.get("run-1")).backoffUntil, null, "a claim clears the backoff");
  await store.release(again, { state: "parked", backoffUntil: clock.now + 60_000 });
  assert.deepEqual(await store.runs.claimable(), []);
  await store.command("run-1", { kind: "stop" });
  assert.deepEqual(await store.runs.claimable(), ["run-1"], "a stop does not wait out a backoff");
  const stopping = await store.claim("run-1", "runner-c", { leaseMs: 30_000 });
  assert.equal(stopping?.from, "parked");
});

test("a parked run's wake_at wakes it whatever its backoff", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.release(claim, { state: "parked", wakeAt: clock.now + 5_000, backoffUntil: clock.now + 60_000 });
  assert.deepEqual(await store.runs.claimable(), []);
  clock.now += 5_000;
  assert.deepEqual(await store.runs.claimable(), ["run-1"]);
});
