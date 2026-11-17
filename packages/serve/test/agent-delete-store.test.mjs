// The store's half of DELETE /v2/agents/{agent_id} (agent-delete.ts), on SQLite and on Postgres alike: the mark a delete
// leaves (another system's agent with an archive time, which only its delete writes) refuses a run's start and a run's
// reopening in the transaction that would write it (AgentDeleting); runs.every names every run of the agent, its learning
// runs included; runs.remove takes a final run's rows and refuses one not final; agents.remove takes the agent's rows once
// it has no run, and refuses before. A runner's late write under a claim of a removed run writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { AgentDeleting, Fenced, RunFinal, StoreConstraint, TriggersLeft } = await import("../dist/store/index.js");

const BODY = { instructions: "Answer the question.", tools: [], skills: {} };
const AGENT = "agent-9";
const REF = "host:expert:9";

/** createInline arguments for run `runId` of expert 9 at version 1 (its agent AGENT on its first run). */
const inline = (runId, origin) => ({
  agent: { id: AGENT, name: "Expert 9", description: null, ref: REF },
  revision: { id: "rev-9", version: "1", kind: "agentic", body: BODY, skills: {} },
  run: { id: runId, ...(origin ? { origin: { key: origin } } : {}) },
  launch: { body: { input: { content: "What is six times seven?" }, title: "six times seven", place: { mode: "runner" } } },
});

/** Run `runId` claimed and ended with `patch` (its end commit's `also` rows with it); answers the claim it ended under. */
async function end(store, runId, patch = { state: "ended" }, rows = {}) {
  const claim = await store.claim(runId, "runner-a", { leaseMs: 30_000 });
  assert.ok(claim, `run ${runId} is claimed`);
  await store.runs.update(claim, patch, rows);
  return claim;
}

test("the delete's mark refuses an external agent's inline run, run and follow-up in their own transactions (AgentDeleting), nothing written", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.createInline(inline("run-a"));
  await end(store, "run-a");
  // The mark: the archive time (the trigger engine's agentArchived writes it with its triggers off).
  await store.agents.archive(AGENT, true);

  await assert.rejects(store.runs.createInline(inline("run-b", "key-b")), AgentDeleting, "an inline run of it");
  await assert.rejects(store.runs.create({ id: "run-c", agentId: AGENT, revisionId: "rev-9" }, { body: { input: { content: "hi" } } }), AgentDeleting, "a run of it");
  await assert.rejects(store.runs.reopen("run-a", { kind: "steer", body: { text: "And eight?" } }), AgentDeleting, "a follow-up opening its run again");
  assert.deepEqual((await store.runs.every(AGENT)).map((run) => [run.id, run.state]), [["run-a", "ended"]], "no run was written, and its run is as it ended");
  assert.equal(await store.runOfOrigin("key-b"), undefined, "nor an origin");
  assert.deepEqual(await store.commands("run-a", 0), [], "nor a command");

  // An agent made here, archived, is no delete's: its refusal stays the server's (needRunnableAgent), as before.
  await agentWithRevision(store, "local-1", "rev-local");
  await store.agents.archive("local-1", true);
  assert.equal((await store.runs.create({ id: "run-local", agentId: "local-1", revisionId: "rev-local" })).id, "run-local");
  // A trigger made off for an archived agent made here stays allowed: nothing deletes that agent's rows.
  await store.triggers.create(schedule("trig-local", "local-1", false));
});

/** A schedule trigger `id` of agent `agentId`, on or off. */
const schedule = (id, agentId, enabled) => ({ id, agentId, name: id, enabled, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: agentId, input: { content: "Answer." } }, nextAt: enabled ? Date.now() + 600_000 : null, catchupWindowS: 0 });

test("the delete's mark refuses a trigger of the agent made, off or on, moved to it or turned on (AgentDeleting), nothing written; agents.remove refuses while a trigger of it is left (TriggersLeft)", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.createInline(inline("run-a"));
  await end(store, "run-a");
  await store.triggers.create(schedule("trig-own", AGENT, false));
  await agentWithRevision(store, "other-1", "rev-other");
  await store.triggers.create(schedule("trig-other", "other-1", false));
  await store.agents.archive(AGENT, true);

  await assert.rejects(store.triggers.create(schedule("trig-off", AGENT, false)), AgentDeleting, "a trigger of it made off");
  await assert.rejects(store.triggers.create(schedule("trig-on", AGENT, true)), AgentDeleting, "a trigger of it made on");
  await assert.rejects(store.triggers.update("trig-other", { agentId: AGENT, target: { kind: "start_run", agent_id: AGENT, input: { content: "Answer." } } }), AgentDeleting, "a trigger moved to it, off");
  await assert.rejects(store.triggers.update("trig-own", { enabled: true, nextAt: Date.now() + 600_000 }), AgentDeleting, "its trigger turned on");
  assert.deepEqual((await store.triggers.list(AGENT)).map((one) => [one.id, one.enabled]), [["trig-own", false]], "nothing written");
  assert.equal((await store.triggers.get("trig-other")).agentId, "other-1");
  // What the server does with a trigger of it that stays off is still written: its name, its next time.
  assert.equal((await store.triggers.update("trig-own", { name: "renamed", nextAt: null })).name, "renamed");

  // A trigger that reached it anyway (one the delete's listing missed) keeps the agent: the next delete removes it first.
  await store.runs.remove("run-a");
  const left = await store.agents.remove(AGENT).then(() => undefined, (error) => error);
  assert.ok(TriggersLeft && left instanceof TriggersLeft, `refused with TriggersLeft: ${left}`);
  assert.deepEqual(left.triggerIds, ["trig-own"]);
  assert.ok(await store.agents.get(AGENT), "the agent is kept");
  assert.equal((await store.triggers.list(AGENT)).length, 1, "and its trigger");
  await store.triggers.remove("trig-own");
  await store.agents.remove(AGENT);
  assert.equal(await store.agents.get(AGENT), undefined, "then removed");
});

test("runs.every names the agent's learning runs; runs.remove refuses a run not final and removes a final one's rows; agents.remove refuses while a run remains, then removes the agent; a late write under a removed run's claim writes nothing", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.createInline(inline("run-a", "key-a"));
  // Its end keeps its learning and queues the learning run that grades it.
  const stale = await end(store, "run-a", { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "proposed", proposal: { notes: [] }, detail: "proposed" } } }, { table: "learning_run", row: { id: "run-a-learning" } }] });
  await store.runs.createInline(inline("run-b"));
  await store.command("run-b", { kind: "cancel", body: {} });
  await store.triggers.create({ id: "trig-9", agentId: AGENT, name: "nightly", enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: AGENT, input: { content: "Answer." } }, nextAt: null, catchupWindowS: 0 });

  const every = await store.runs.every(AGENT);
  assert.deepEqual(every.map((run) => run.id).sort(), ["run-a", "run-a-learning", "run-b"], "its learning run too");
  assert.deepEqual((await store.runs.list({ agentId: AGENT })).map((run) => run.id).sort(), ["run-a", "run-b"], "which the list leaves out");

  await assert.rejects(store.runs.remove("run-b"), StoreConstraint, "a queued run is not removed");
  await assert.rejects(store.runs.remove("run-a-learning"), StoreConstraint, "nor a queued learning run");
  await assert.rejects(store.agents.remove(AGENT), StoreConstraint, "an agent with runs is not removed");
  assert.equal((await store.runs.get("run-b")).state, "queued", "nothing written");
  assert.ok(await store.agents.get(AGENT));

  await end(store, "run-b", { state: "stopped", outcome: "cancelled" });
  await end(store, "run-a-learning");
  for (const run of every) await store.runs.remove(run.id);
  for (const run of every) assert.equal(await store.runs.get(run.id), undefined, `run ${run.id} is gone`);
  assert.equal(await store.runOfOrigin("key-a"), undefined, "its origin is gone");
  await assert.rejects(store.runs.launch("run-a"), "its launch record is gone");
  assert.deepEqual(await store.commands("run-b", 0), [], "its commands are gone");
  assert.deepEqual(await store.runs.every(AGENT), []);

  // The runner that ended run-a, writing late under its claim: refused, nothing written back.
  await assert.rejects(store.runs.update(stale, { summary: "late" }), Fenced, "a late run update");
  await assert.rejects(async () => commitWrites(store.journal(stale), [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT), Fenced, "a late journal commit");
  await assert.rejects(store.command("run-a", { kind: "steer", body: {} }), RunFinal, "a command for it");
  assert.equal(await store.runs.get("run-a"), undefined, "no row came back");

  // Its trigger is removed by the delete's trigger path (agent-delete.ts), never with the agent's rows.
  await assert.rejects(store.agents.remove(AGENT), (error) => error?.name === "TriggersLeft", "an agent with a trigger left is not removed");
  assert.ok(await store.agents.get(AGENT));
  await store.triggers.remove("trig-9");
  await store.agents.remove(AGENT);
  assert.equal(await store.agents.get(AGENT), undefined, "the agent is gone");
  assert.equal(await store.agents.byExternal(REF), undefined, "and its reference");
  assert.deepEqual(await store.agents.revisions(AGENT), [], "its revisions");
  assert.deepEqual(await store.triggers.list(AGENT), [], "its trigger");
  assert.equal(await store.triggers.get("trig-9"), undefined);

  // Both are idempotent: a second remove of either writes nothing and throws nothing.
  await store.runs.remove("run-a");
  await store.agents.remove(AGENT);
  // The same reference makes a new agent after.
  const again = await store.runs.createInline({ ...inline("run-d"), agent: { ...inline("run-d").agent, id: "agent-9b" } });
  assert.equal(again.agentId, "agent-9b");
});

/** A delete's host over the real store, the server's things outside the store left out: the mark is the archive (as the
 *  trigger engine's agentArchived writes it), a cancel is a cancel command the runner then ends the run on, a trigger is
 *  removed by the store. `crashAt` throws at that step's point once, as a crash there would stop the delete. */
function storeHost(store, crashAt) {
  const learning = [];
  const crash = { done: false };
  const host = {
    store,
    deleteLearning: async (given, agentId) => {
      const going = (await given.runs.every(agentId)).filter((run) => !["ended", "stopped", "failed"].includes(run.state));
      learning.push({ refusing: (await given.agents.get(agentId))?.archivedAt != null, going: going.length });
    },
    refuse: async (agentId) => void (await store.agents.archive(agentId, true)),
    cancel: async (runId) => {
      await store.command(runId, { kind: "cancel", body: {} });
      await end(store, runId, { state: "stopped", outcome: "cancelled" });
      return true;
    },
    removeTriggerThere: async () => {},
    removeTriggerSettings: async () => {},
    removeTrigger: (id) => store.triggers.remove(id),
    forgetSignIns: async () => {},
    removeOwnComputer: async () => {},
    removeDisk: async () => {},
    forgetRun: async () => {},
    forgetAgent: async () => {},
    waitMs: 5_000,
    pollMs: 5,
    at: (step) => {
      if (step !== crashAt || crash.done) return;
      crash.done = true;
      throw new Error(`stopped ${step}`);
    },
  };
  return { host, learning, crash };
}

for (const step of ["after_step_1", "after_step_2", "in_step_3"]) {
  test(`a delete stopped ${step.replaceAll("_", " ")} leaves the agent there and refusing runs in the store; the next delete finishes it`, async (t) => {
    const { deleteExternalAgent } = await import("../dist/agent-delete.js");
    const { store } = await storeOn(t);
    await store.runs.createInline(inline("run-a", "key-a"));
    await end(store, "run-a");
    await store.runs.createInline(inline("run-b"));
    await store.triggers.create({ id: "trig-9", agentId: AGENT, name: "nightly", enabled: true, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: AGENT, input: { content: "Answer." } }, nextAt: Date.now() + 600_000, catchupWindowS: 0 });

    const { host, learning, crash } = storeHost(store, step);
    await assert.rejects(deleteExternalAgent(host, AGENT), new RegExp(`stopped ${step}`));
    assert.ok(crash.done);
    assert.ok((await store.agents.get(AGENT))?.archivedAt != null, "the agent is there, marked");
    assert.equal((await store.runs.get("run-b")).state, "stopped", "its run going was stopped");
    assert.equal(learning.length, step === "after_step_1" ? 0 : 1);
    assert.equal((await store.triggers.list(AGENT)).length, step === "in_step_3" ? 0 : 1, step === "in_step_3" ? "its trigger went first in step 3" : "its trigger is kept to step 3");
    if (step === "in_step_3") assert.equal(await store.runs.get("run-a"), undefined, "and its first run");
    await assert.rejects(store.runs.createInline(inline("run-c")), AgentDeleting, "it refuses an inline run");
    await assert.rejects(store.runs.create({ id: "run-d", agentId: AGENT, revisionId: "rev-9" }), AgentDeleting, "and a run");

    await deleteExternalAgent(host, AGENT);
    assert.deepEqual(learning.at(-1), { refusing: true, going: 0 }, "its learning deleted with it refusing and none going");
    assert.equal(await store.agents.get(AGENT), undefined, "the agent is gone");
    assert.deepEqual(await store.runs.every(AGENT), [], "its runs");
    assert.deepEqual(await store.triggers.list(AGENT), [], "its trigger");
    assert.deepEqual(await store.agents.revisions(AGENT), [], "its revisions");
    assert.equal(await store.runOfOrigin("key-a"), undefined, "its run's origin");
  });
}
