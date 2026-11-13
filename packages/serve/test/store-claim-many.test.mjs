// A runner fills its free loops with one transaction (runs.claimMany): up to k claimable runs, oldest first, each at its
// own epoch + 1 and with the state it was in. A claim per run costs a serialized commit each (about 6 ms here), so 300
// loops, or a reclaim after a runner dies, would take seconds one by one. Two runners claiming batches at once never take
// the same run, and between them they take every one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

test("claimMany claims up to k claimable runs, oldest first, in one transaction, each at its own epoch + 1 and with what it was", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const id of ["run-a", "run-b", "run-c", "run-d"]) {
    await queued(store, id);
    clock.now += 1_000;
  }
  const earlier = await store.claim("run-b", "runner-x", { leaseMs: 1_000 });
  await store.release(earlier);
  const claims = await store.runs.claimMany("runner-a", 3, { leaseMs: 30_000 });
  assert.deepEqual(claims.map((c) => [c.runId, c.epoch, c.from, c.runner, c.until]), [
    ["run-a", 1, "queued", "runner-a", clock.now + 30_000],
    ["run-b", 3, "running", "runner-a", clock.now + 30_000],
    ["run-c", 1, "queued", "runner-a", clock.now + 30_000],
  ]);
  assert.deepEqual(await store.runs.claimable(), ["run-d"], "the rest stays claimable");
  assert.deepEqual(await store.runs.claimMany("runner-a", 0), [], "none asked, none claimed");
  assert.deepEqual((await store.runs.claimMany("runner-a", 5, { leaseMs: 30_000 })).map((c) => c.runId), ["run-d"], "fewer when fewer are claimable");
});

test("two runners claiming batches at once never claim the same run, and together they claim every one", async (t) => {
  const { store, clock, file } = await storeOn(t);
  const ids = Array.from({ length: 40 }, (_, i) => `run-${String(i).padStart(2, "0")}`);
  for (const id of ids) await queued(store, id);
  const { store: other } = await storeOn(t, { clock, file, role: "runner" });
  const batches = [];
  const takeAll = async (s, runner) => {
    for (;;) {
      const got = await s.runs.claimMany(runner, 7, { leaseMs: 60_000 });
      if (got.length === 0) return;
      batches.push(...got);
    }
  };
  await Promise.all([takeAll(store, "runner-a"), takeAll(other, "runner-b")]);
  const taken = batches.map((c) => c.runId);
  assert.equal(new Set(taken).size, taken.length, "no run claimed twice");
  assert.deepEqual([...taken].sort(), ids, "every run claimed");
  for (const c of batches) assert.equal(c.epoch, 1);
});
