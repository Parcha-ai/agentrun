// Commands are rows (design: "commands from the console are rows, not files or doors"): the server writes one for a run, the
// run's runner reads them after a cursor and marks each taken, or refused with why. A command for a final run is refused in
// the insert itself, so a run's last commit and a command never race.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Fenced, RunFinal } from "../dist/store/store.js";
import { queued, storeOn } from "./store-helpers.mjs";

test("commands are read after a cursor, in id order, and marked taken once under the claim", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const steer = await store.command("run-1", { kind: "steer", body: { text: "shorter" } });
  const stop = await store.command("run-1", { kind: "stop" });
  assert.deepEqual([steer.kind, steer.body, steer.createdAt, steer.takenAt, steer.refused], ["steer", { text: "shorter" }, clock.now, null, null]);
  assert.deepEqual((await store.commands("run-1", 0)).map((c) => c.id), [steer.id, stop.id]);
  assert.deepEqual((await store.commands("run-1", steer.id)).map((c) => c.id), [stop.id], "after the cursor");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.take(claim, steer.id);
  clock.now += 5;
  await store.take(claim, steer.id);
  assert.deepEqual((await store.commands("run-1", 0)).map((c) => [c.id, c.takenAt, c.refused]), [[steer.id, clock.now - 5, null], [stop.id, null, null]], "taken once: the second take changes nothing");
});

test("a command refused by the runner keeps why, and a stale claim's take is Fenced and writes nothing", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const raise = await store.command("run-1", { kind: "raise", body: { usd: 5 } });
  const stale = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 2_000;
  const fresh = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  await assert.rejects(store.take(stale, raise.id, "refused", "stale"), Fenced);
  assert.equal((await store.commands("run-1", 0))[0].takenAt, null, "the stale take wrote nothing");
  await store.take(fresh, raise.id, "refused", "the run has no cap to raise");
  assert.deepEqual((await store.commands("run-1", 0)).map((c) => [c.takenAt, c.refused]), [[clock.now, "the run has no cap to raise"]]);
});

test("a command for a final run, or no run, is refused (RunFinal) and nothing is written", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.runs.update(claim, { state: "stopped" });
  await assert.rejects(store.command("run-1", { kind: "steer", body: { text: "go on" } }), (error) => error instanceof RunFinal && error.runId === "run-1");
  await assert.rejects(store.command("run-none", { kind: "stop" }), RunFinal);
  assert.deepEqual(await store.commands("run-1", 0), []);
});
