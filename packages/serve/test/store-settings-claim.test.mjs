import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn, agentWithRevision, queued } from "./store-helpers.mjs";

for (const cause of ["reclaimed", "lease elapsed", "terminal"]) {
  test(`settings CAS under a claim refuses ${cause} without changing evidence`, async t => {
    const { store, clock } = await storeOn(t); await agentWithRevision(store); await queued(store);
    const old = { run_id: "run-1", batches: [] }, next = { ...old, closed: "expired" };
    await store.settings.put("sdk-run:run-1", old);
    const claim = await store.claim("run-1", "first", { leaseMs: 1_000 }); assert.ok(claim);
    if (cause === "reclaimed") { await store.release(claim); assert.ok(await store.claim("run-1", "second")); }
    if (cause === "lease elapsed") clock.now += 1_001;
    if (cause === "terminal") await store.runs.update(claim, { state: "failed", costUsd: null, metrics: null });
    await assert.rejects(store.settings.replaceIf("sdk-run:run-1", old, next, claim), error => error.name === "Fenced");
    assert.deepEqual(await store.settings.get("sdk-run:run-1"), old);
    assert.equal(await store.settings.replaceIf("sdk-run:run-1", old, { ...old, receipt: true }), true, "ordinary unclaimed CAS keeps its contract");
  });
}

// An insert under a claim (Settings.putIfAbsent's claim): a park's keep row written from no row, fenced in the same
// transaction as the insert, as the CAS above is.
for (const cause of ["reclaimed", "lease elapsed", "terminal"]) {
  test(`settings insert under a claim refuses ${cause} and writes nothing`, async t => {
    const { store, clock } = await storeOn(t); await agentWithRevision(store); await queued(store);
    const row = { provider: "docker", kind: "sandbox", id: "c1", name: "c1", epoch: 1, until: 0 };
    const claim = await store.claim("run-1", "first", { leaseMs: 1_000 }); assert.ok(claim);
    if (cause === "reclaimed") { await store.release(claim); assert.ok(await store.claim("run-1", "second")); }
    if (cause === "lease elapsed") clock.now += 1_001;
    if (cause === "terminal") await store.runs.update(claim, { state: "failed", costUsd: null, metrics: null });
    await assert.rejects(store.settings.putIfAbsent("computer_kept:run-1", row, undefined, claim), error => error.name === "Fenced");
    assert.equal(await store.settings.get("computer_kept:run-1"), undefined, "nothing written under a claim that no longer holds the run");
    assert.deepEqual(await store.settings.putIfAbsent("computer_kept:run-1", row), row, "ordinary unclaimed insert keeps its contract");
  });
}

test("settings insert under the run's claim writes as an unclaimed one: the first value wins and is answered after", async t => {
  const { store } = await storeOn(t); await agentWithRevision(store); await queued(store);
  const claim = await store.claim("run-1", "first"); assert.ok(claim);
  const row = { provider: "docker", kind: "sandbox", id: "c1", name: "c1", epoch: claim.epoch, until: 0 };
  assert.deepEqual(await store.settings.putIfAbsent("computer_kept:run-1", row, undefined, claim), row);
  assert.deepEqual(await store.settings.putIfAbsent("computer_kept:run-1", { ...row, id: "c2" }, undefined, claim), row, "a key with a row keeps it");
});

test("settings CAS checks both current claim and exact value, allowing only one concurrent writer", async t => {
  const { store } = await storeOn(t); await agentWithRevision(store); await queued(store);
  const claim = await store.claim("run-1", "first"); assert.ok(claim);
  const old = { run_id: "run-1", batches: [] }; await store.settings.put("sdk-run:run-1", old);
  const answers = await Promise.all([
    store.settings.replaceIf("sdk-run:run-1", old, { ...old, closed: "expired" }, claim),
    store.settings.replaceIf("sdk-run:run-1", old, { ...old, completion: "reported" }),
  ]);
  assert.equal(answers.filter(Boolean).length, 1);
  const saved = await store.settings.get("sdk-run:run-1"); assert.equal(Boolean(saved.closed) !== Boolean(saved.completion), true);
  assert.equal(await store.settings.replaceIf("sdk-run:run-1", old, { ...old, replaced: true }, claim), false);
});
