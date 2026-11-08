// A runner holds many runs, and its periodic store traffic is per runner, never per run: one read of every held run's new
// command rows a tick (commandsOf), and one transaction renewing every held claim (renewMany), as run_live's write is one
// for all of them. A claim another runner took is answered Fenced on its own; the others renew in the same transaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Fenced } from "../dist/store/index.js";
import { queued, storeOn } from "./store-helpers.mjs";

test("commandsOf reads each run's command rows after its own cursor, every run in one read", async (t) => {
  const { store } = await storeOn(t);
  for (const id of ["run-1", "run-2", "run-3"]) await queued(store, id);
  const a1 = await store.command("run-1", { kind: "steer", body: { content: "a1" } });
  const b1 = await store.command("run-2", { kind: "steer", body: { content: "b1" } });
  const a2 = await store.command("run-1", { kind: "steer", body: { content: "a2" } });
  const reads = [];
  const all = store.commands.bind(store);
  store.commands = (...args) => (reads.push(args), all(...args));
  const rows = await store.commandsOf([{ runId: "run-1", after: a1.id }, { runId: "run-2", after: 0 }, { runId: "run-3", after: 0 }]);
  assert.deepEqual(rows.get("run-1")?.map((row) => row.id), [a2.id], "run-1 after its cursor");
  assert.deepEqual(rows.get("run-2")?.map((row) => row.id), [b1.id]);
  assert.deepEqual(rows.get("run-3") ?? [], []);
  assert.equal(reads.length, 0, "never a read per run");
});

test("renewMany renews every held claim in one transaction, and answers a fenced one Fenced while the others renew", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const id of ["run-1", "run-2", "run-3"]) await queued(store, id);
  const claims = [];
  for (const id of ["run-1", "run-2", "run-3"]) claims.push(await store.claim(id, "runner-a", { leaseMs: 1_000 }));
  // run-2's claim runs out and another runner takes it.
  clock.now += 1_001;
  await store.claim("run-2", "runner-b", { leaseMs: 60_000 });
  const results = await store.renewMany(claims, { leaseMs: 30_000 });
  assert.equal(results.length, 3);
  assert.equal(results[0].until, clock.now + 30_000, "run-1 renewed");
  assert.ok(results[1] instanceof Fenced && results[1].runId === "run-2", `run-2 answered Fenced: ${results[1]}`);
  assert.equal(results[2].until, clock.now + 30_000, "run-3 renewed beside it");
  assert.equal((await store.runs.get("run-2")).runner, "runner-b", "nothing written to the fenced run");
});
