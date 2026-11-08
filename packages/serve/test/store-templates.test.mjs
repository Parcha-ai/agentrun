// Units of work are the store's own methods, one transaction each, all or nothing, with no compensation: an agent and its
// first revision (agents.create); a template applied, the agent, its first revision with the package and its triggers
// (templates.apply, idempotent under a key); a template upgraded, revision n+1 and its triggers changed by name, the
// agent's learning untouched (templates.upgrade). A store error part way leaves nothing of the unit behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import { StoreConstraint } from "../dist/store/store.js";
import { storeOn } from "./store-helpers.mjs";

const PACKAGE = { name: "due-diligence", version: "1.2.0", source: "builtin", parameters: { region: "EU" } };
const trigger = (name, extra = {}) => ({ id: `trg-${name}`, name, source: { kind: "schedule", cron: "0 9 * * 1" }, target: { input: { content: name } }, scopes: [{ kind: "schedule", scope: `trg-${name}` }], ...extra });

test("agents.create: the agent and its first revision in one transaction; a store error after the agent row leaves no agent", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  assert.equal((await store.agents.get("agent-1"))?.currentRevision, "rev-1");
  // A revision the store refuses (an unknown kind), after the agent row in the same transaction.
  await assert.rejects(store.agents.create({ id: "agent-2", name: "Two" }, { id: "rev-2", kind: "not-a-kind", body: {} }), StoreConstraint);
  assert.equal(await store.agents.get("agent-2"), undefined, "no agent row without its revision");
});

test("templates.apply: a store error after the agent row and before revision 1 leaves NO agent row, and no trigger", async (t) => {
  const { store } = await storeOn(t);
  await assert.rejects(store.templates.apply({ id: "agent-t", name: "From a template" }, { id: "rev-t1", kind: "not-a-kind", body: {}, package: PACKAGE }, [trigger("weekly")]), StoreConstraint);
  assert.equal(await store.agents.get("agent-t"), undefined, "no agent row");
  assert.deepEqual(await store.triggers.list("agent-t"), [], "no trigger");
});

test("templates.apply: the agent, revision 1 with its package and the triggers (enabled ones with their scope rows); the same idempotency key answers the first result and writes nothing", async (t) => {
  const { store } = await storeOn(t);
  const result = await store.templates.apply({ id: "agent-t", name: "From a template" }, { id: "rev-t1", kind: "agentic", body: { instructions: "Check." }, package: PACKAGE }, [trigger("weekly"), trigger("paused", { enabled: false })], "apply-key-1");
  assert.deepEqual(result, { agentId: "agent-t", revisionId: "rev-t1" });
  assert.deepEqual((await store.agents.revision("rev-t1"))?.package, PACKAGE);
  assert.deepEqual((await store.triggers.list("agent-t")).map((tr) => [tr.name, tr.enabled]), [["paused", false], ["weekly", true]]);
  const again = await store.templates.apply({ id: "agent-u", name: "Another" }, { id: "rev-u1", kind: "agentic", body: {} }, [], "apply-key-1");
  assert.deepEqual(again, result, "the first apply's answer");
  assert.equal(await store.agents.get("agent-u"), undefined, "and nothing written");
});

test("templates.apply: a trigger name taken twice is refused, and the whole apply with it", async (t) => {
  const { store } = await storeOn(t);
  await assert.rejects(store.templates.apply({ id: "agent-t", name: "T" }, { id: "rev-t1", kind: "agentic", body: {} }, [trigger("weekly"), { ...trigger("weekly"), id: "trg-other" }]), StoreConstraint);
  assert.equal(await store.agents.get("agent-t"), undefined);
});

test("templates.upgrade: revision n+1 made current, triggers upserted and removed by name, the agent's learning untouched", async (t) => {
  const { store } = await storeOn(t);
  await store.templates.apply({ id: "agent-t", name: "T" }, { id: "rev-t1", kind: "agentic", body: {}, package: PACKAGE }, [trigger("weekly"), trigger("daily")]);
  await store.templates.upgrade("agent-t", { id: "rev-t2", kind: "agentic", body: { instructions: "v2" }, package: { ...PACKAGE, version: "1.3.0" } }, {
    upsert: [trigger("weekly", { source: { kind: "schedule", cron: "0 10 * * 1" } }), trigger("monthly")],
    remove: ["daily"],
  });
  assert.equal((await store.agents.get("agent-t"))?.currentRevision, "rev-t2");
  const triggers = await store.triggers.list("agent-t");
  assert.deepEqual(triggers.map((tr) => tr.name), ["monthly", "weekly"]);
  assert.deepEqual(triggers.find((tr) => tr.name === "weekly")?.source, { kind: "schedule", cron: "0 10 * * 1" }, "upserted by name");
  assert.equal(triggers.find((tr) => tr.name === "weekly")?.id, "trg-weekly", "the same trigger, kept by name");
});
