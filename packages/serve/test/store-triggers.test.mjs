// A trigger's three store methods (module E builds the rest on them): enable and disable change the trigger and its scope
// rows in one call; fire starts a run, the queued run, the `started` firing that names it and the trigger's last run, in one
// transaction, so a firing never names a run that is not there and no run is started by a firing that is not recorded.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as stored from "../dist/store/store.js";

const { StoreConstraint } = stored;
import { storeOn } from "./store-helpers.mjs";

async function withTrigger(store) {
  await store.templates.apply({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: {} }, [{ id: "trg-1", name: "weekly", source: { kind: "schedule" }, target: {}, scopes: [{ kind: "schedule", scope: "trg-1" }] }]);
}

test("a trigger belongs to an agent the store holds: one made, or moved, for an agent it does not hold is refused in words and writes nothing", async (t) => {
  const { store } = await storeOn(t);
  await withTrigger(store);
  const ghost = { id: "trg-2", agentId: "agent-ghost", name: "nightly", enabled: true, source: { kind: "schedule" }, target: {}, nextAt: null, catchupWindowS: 3600 };
  await assert.rejects(store.triggers.create(ghost), (error) => error instanceof StoreConstraint && error.message === "no agent agent-ghost: a trigger belongs to an agent the store holds");
  assert.equal(await store.triggers.get("trg-2"), undefined, "nothing made");
  await assert.rejects(store.triggers.update("trg-1", { agentId: "agent-ghost", name: "moved" }), (error) => error instanceof StoreConstraint && /^no agent agent-ghost: /.test(error.message));
  assert.deepEqual([(await store.triggers.get("trg-1")).agentId, (await store.triggers.get("trg-1")).name], ["agent-1", "weekly"], "nothing moved");
});

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

test("an agent's archive turns off its triggers that are on, with the why given, and drops their scope rows, in its one transaction; after it no firing starts a run of the agent, and none of its triggers is made or turned on; unarchived, none turns on", async (t) => {
  const { store, clock } = await storeOn(t);
  await withTrigger(store);
  await store.agents.create({ id: "agent-2", name: "Two" }, { id: "rev-2", kind: "agentic", body: {} });
  const trigger = (id, agentId, name, enabled) => ({ id, agentId, name, enabled, source: { kind: "schedule" }, target: {}, nextAt: enabled ? clock.now + 60_000 : null, catchupWindowS: 3600 });
  await store.triggers.create(trigger("trg-other", "agent-2", "other", true));
  await store.triggers.create({ ...trigger("trg-off", "agent-1", "paused", false) });
  await store.triggers.disable("trg-off", { reason: "owner paused it" });
  // A firing recorded due before the archive.
  await store.triggers.record("trg-1", [{ key: "k-due", by: "schedule", nominalAt: clock.now, status: "due" }]);
  const why = { at: "2026-11-09T09:00:00.000Z", reason: "agent_archived", detail: "The agent One is archived." };
  assert.deepEqual(await store.agents.archive("agent-1", true, why), [{ id: "trg-1", name: "weekly" }], "the triggers it turned off");
  assert.notEqual((await store.agents.get("agent-1")).archivedAt, null);
  const off = await store.triggers.get("trg-1");
  assert.deepEqual([off.enabled, off.nextAt, off.disabled], [false, null, why]);
  assert.deepEqual(await store.triggers.scoped("schedule", "trg-1"), [], "its scope rows gone with it");
  assert.deepEqual((await store.triggers.get("trg-off")).disabled, { reason: "owner paused it" }, "one already off keeps its own why");
  assert.equal((await store.triggers.get("trg-other")).enabled, true, "another agent's stays on");
  // The firing due from before starts no run now: refused in the fire's own transaction, nothing written.
  const refused = (error) => error instanceof stored.AgentArchived &&error.agentId === "agent-1" && error.message === "the agent agent-1 is archived";
  await assert.rejects(store.triggers.fire({ triggerId: "trg-1", key: "k-due" }, { id: "run-1", agentId: "agent-1", revisionId: "rev-1" }), refused);
  assert.equal(await store.runs.get("run-1"), undefined, "no run");
  assert.deepEqual([(await store.triggers.firing("trg-1", "k-due")).status, (await store.triggers.get("trg-1")).lastRunId], ["due", null], "the firing as it was");
  // Nor is a trigger of it made on, turned on, or moved onto it on; one made off is.
  await assert.rejects(store.triggers.create(trigger("trg-new", "agent-1", "new", true)), refused);
  await assert.rejects(store.triggers.update("trg-1", { enabled: true, disabled: null }), refused);
  await assert.rejects(store.triggers.enable("trg-1", []), refused);
  await assert.rejects(store.triggers.update("trg-other", { agentId: "agent-1" }), refused);
  assert.deepEqual([(await store.triggers.get("trg-1")).enabled, (await store.triggers.get("trg-other")).agentId], [false, "agent-2"], "the refusals wrote nothing");
  assert.equal((await store.triggers.create(trigger("trg-new", "agent-1", "new", false))).enabled, false);
  // Unarchived: none turns on.
  assert.deepEqual(await store.agents.archive("agent-1", false), []);
  assert.equal((await store.agents.get("agent-1")).archivedAt, null);
  assert.deepEqual([(await store.triggers.get("trg-1")).enabled, (await store.triggers.get("trg-1")).disabled], [false, why], "still off, with why, until turned on");
  assert.equal((await store.triggers.update("trg-1", { enabled: true, disabled: null })).enabled, true);
  const run = await store.triggers.fire({ triggerId: "trg-1", key: "k-due" }, { id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  assert.equal(run.id, "run-1", "the firing starts its run once the agent is back");
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

test("a trigger's conversations: kept by key, its run named once and never moved, its last time only forward; pruned past its age and past the newest it keeps; gone with its trigger", async (t) => {
  const { store, clock } = await storeOn(t);
  await withTrigger(store);
  await store.triggers.fire({ triggerId: "trg-1", key: "k1", by: "schedule" }, { id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const at = clock.now;
  assert.equal(await store.triggers.conversation("trg-1", "C1:1.0"), undefined, "none yet");
  await store.triggers.keepConversation({ triggerId: "trg-1", key: "C1:1.0", at });
  assert.deepEqual(await store.triggers.conversation("trg-1", "C1:1.0"), { triggerId: "trg-1", key: "C1:1.0", runId: null, createdAt: at, lastAt: at }, "kept before its run started");
  await store.triggers.keepConversation({ triggerId: "trg-1", key: "C1:1.0", runId: "run-1", at: at + 10 });
  await store.triggers.keepConversation({ triggerId: "trg-1", key: "C1:1.0", at: at + 5 });
  assert.deepEqual(await store.triggers.conversation("trg-1", "C1:1.0"), { triggerId: "trg-1", key: "C1:1.0", runId: "run-1", createdAt: at, lastAt: at + 10 }, "its run named; a later write without one keeps it, an earlier time does not go back");
  for (const [key, ago] of [["old", 31_000], ["a", 3], ["b", 2], ["c", 1]]) await store.triggers.keepConversation({ triggerId: "trg-1", key, at: at - ago });
  const pruned = await store.triggers.pruneConversations("trg-1", { keptMs: 30_000, kept: 3, now: at });
  assert.equal(pruned, 2, "the stale one and the oldest past three");
  const kept = [];
  for (const key of ["C1:1.0", "old", "a", "b", "c"]) if (await store.triggers.conversation("trg-1", key)) kept.push(key);
  assert.deepEqual(kept, ["C1:1.0", "b", "c"]);
  assert.equal(await store.triggers.pruneConversations("trg-1", { keptMs: 30_000, kept: 3, now: at }), 0, "nothing more");
  assert.equal(await store.triggers.conversation("trg-2", "C1:1.0"), undefined, "another trigger's are its own");
  await store.triggers.remove("trg-1");
  assert.equal(await store.triggers.conversation("trg-1", "C1:1.0"), undefined, "gone with its trigger");
});
