// The store's claim is the one fence for a run (design 2.1 and "the claim epoch is the one fence"): a claim moves the
// run's epoch up by one, and every write a runner makes for the run carries the epoch it holds. A write under a stale
// epoch is refused (Fenced) and writes nothing. A claim that ran out (claimed_until passed) is taken by the next claimer,
// and of two claimers at once exactly one wins.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Fenced } from "../../dist/store/store.js";
import { openSqliteStore } from "../../dist/store/sqlite/store.js";

/** A store file in a directory of its own, removed after the test; `clock` is the store's now, in ms. */
async function opened(t, clock = { now: Date.parse("2026-11-08T05:00:00Z") }, file) {
  const dir = file ? undefined : mkdtempSync(join(tmpdir(), "store-claim-"));
  const path = file ?? join(dir, "store.sqlite");
  const store = await openSqliteStore({ file: path, now: () => clock.now });
  t.after(async () => {
    await store.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return { store, file: path, clock };
}

/** An agent, its revision and one queued run. */
async function queued(store, runId = "run-1") {
  await store.agents.put({ id: "agent-1", name: "Agent one" });
  await store.agents.addRevision({ id: "rev-1", agentId: "agent-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" });
}

test("a claim moves the run's epoch up by one and holds it running until claimed_until", async (t) => {
  const { store, clock } = await opened(t);
  await queued(store);
  assert.deepEqual(await store.runs.get("run-1").then((run) => [run.state, run.epoch, run.runner]), ["queued", 0, null]);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  assert.deepEqual(claim, { runId: "run-1", runner: "runner-a", epoch: 1, until: new Date(clock.now + 30_000).toISOString() });
  const run = await store.runs.get("run-1");
  assert.deepEqual([run.state, run.epoch, run.runner, run.claimedUntil], ["running", 1, "runner-a", claim.until]);
  assert.equal(await store.claim("run-1", "runner-b", { leaseMs: 30_000 }), null, "a live claim is not taken");
});

test("a run update under a stale epoch is refused (Fenced) and writes nothing", async (t) => {
  const { store, clock } = await opened(t);
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
  assert.deepEqual(await store.runs.get("run-1").then((run) => [run.state, run.costUsd, run.summary, run.epoch]), ["ended", 0.25, "done", 2]);
});

test("an expired claim is reclaimed by the next claimer, and the holder's renew before it runs out keeps it", async (t) => {
  const { store, clock } = await opened(t);
  await queued(store);
  const held = await store.claim("run-1", "runner-a", { leaseMs: 10_000 });
  clock.now += 8_000;
  const renewed = await store.renew(held, { leaseMs: 10_000 });
  assert.equal(renewed.epoch, 1, "a renew keeps the epoch");
  clock.now += 8_000;
  assert.equal(await store.claim("run-1", "runner-b", { leaseMs: 10_000 }), null, "renewed, it has not run out");
  clock.now += 3_000;
  const taken = await store.claim("run-1", "runner-b", { leaseMs: 10_000 });
  assert.deepEqual([taken?.epoch, taken?.runner], [2, "runner-b"], "run out, it is reclaimed");
});

test("two claimers at once on one queued run: exactly one wins", async (t) => {
  const { store, file, clock } = await opened(t);
  await queued(store);
  // A second process's store on the same file (one connection per process).
  const { store: other } = await opened(t, clock, file);
  const claims = await Promise.all([store.claim("run-1", "runner-a", { leaseMs: 30_000 }), other.claim("run-1", "runner-b", { leaseMs: 30_000 })]);
  assert.equal(claims.filter(Boolean).length, 1, JSON.stringify(claims));
  assert.equal(claims.find(Boolean).epoch, 1);
  assert.equal((await store.runs.get("run-1")).runner, claims.find(Boolean).runner);
});

test("a release gives the run back (no runner, no claimed_until) and the next claim moves the epoch again; an ended run is never claimed", async (t) => {
  const { store } = await opened(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.runs.update(claim, { state: "parked" });
  await store.release(claim);
  const run = await store.runs.get("run-1");
  assert.deepEqual([run.state, run.runner, run.claimedUntil, run.epoch], ["parked", null, null, 1]);
  const again = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.equal(again?.epoch, 2, "a released parked run is claimed again");
  await store.runs.update(again, { state: "ended" });
  await store.release(again);
  assert.equal(await store.claim("run-1", "runner-c", { leaseMs: 30_000 }), null, "an ended run is final");
});
