// A trigger's three store methods (module E builds the rest on them): enable and disable change the trigger and its scope
// rows in one call; fire starts a run, the queued run, the `started` firing that names it and the trigger's last run, in one
// transaction, so a firing never names a run that is not there and no run is started by a firing that is not recorded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { StoreConstraint } from "../dist/store/store.js";
import { storeOn } from "./store-helpers.mjs";

async function withTrigger(store) {
  await store.templates.apply({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: {} }, [{ id: "trg-1", name: "weekly", source: { kind: "schedule" }, target: {}, scopes: [{ kind: "schedule", scope: "trg-1" }] }]);
}

test("fire: the queued run, the started firing and the trigger's last run in one transaction; a firing key taken twice starts no second run", async (t) => {
  const { store, clock } = await storeOn(t);
  await withTrigger(store);
  const run = await store.triggers.fire({ triggerId: "trg-1", key: "2026-11-09T09:00", by: "schedule", nominalAt: clock.now }, { id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  assert.deepEqual([run.id, run.state], ["run-1", "queued"]);
  assert.equal((await store.triggers.get("trg-1"))?.lastRunId, "run-1");
  // The same firing again: its insert is refused after the run's, in one transaction, so the second run is not there.
  await assert.rejects(store.triggers.fire({ triggerId: "trg-1", key: "2026-11-09T09:00", by: "schedule" }, { id: "run-2", agentId: "agent-1", revisionId: "rev-1" }), StoreConstraint);
  assert.equal(await store.runs.get("run-2"), undefined, "no run without its firing");
  assert.equal((await store.triggers.get("trg-1"))?.lastRunId, "run-1");
});

test("disable and enable change the trigger and its scope rows together", async (t) => {
  const { store } = await storeOn(t);
  await withTrigger(store);
  await store.triggers.disable("trg-1", { reason: "owner paused it" });
  assert.equal((await store.triggers.get("trg-1"))?.enabled, false);
  // A second trigger may take the scope once the first gave it up.
  await store.templates.upgrade("agent-1", { id: "rev-2", kind: "agentic", body: {} }, { upsert: [{ id: "trg-2", name: "other", source: {}, target: {}, scopes: [{ kind: "schedule", scope: "trg-1" }] }], remove: [] });
  await assert.rejects(store.triggers.enable("trg-1", [{ kind: "schedule", scope: "trg-1" }]), StoreConstraint, "the scope is taken now");
  assert.equal((await store.triggers.get("trg-1"))?.enabled, false, "and the refused enable changed nothing");
  await store.triggers.disable("trg-2");
  await store.triggers.enable("trg-1", [{ kind: "schedule", scope: "trg-1" }]);
  assert.equal((await store.triggers.get("trg-1"))?.enabled, true);
});
