// The store's half of DELETE /v2/agents/{agent_id} and DELETE /v2/runs/{run_id} (agent-delete.ts), on SQLite and on
// Postgres alike: the mark a delete leaves (agents.markDeleting, on any agent) refuses a run's start and a run's
// reopening in the transaction that would write it (AgentDeleting); runs.every names every run of the agent;
// runs.madeFrom the runs made from a run; runs.remove takes a final run's rows and refuses one not final, and leaves no
// table naming it; agents.remove takes the agent's rows, its mark with them, once it has no run, and refuses before. A
// runner's late write under a claim of a removed run writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

const { dropGrades, gradesOf, putGrade } = await import("../dist/learn/promote.js");

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
  // The mark (the delete's first write, before the trigger engine archives the agent with its triggers off).
  assert.equal((await store.agents.get(AGENT)).deleting, false);
  await store.agents.markDeleting(AGENT);
  await store.agents.markDeleting(AGENT);
  assert.equal((await store.agents.get(AGENT)).deleting, true, "read with the agent; marking twice is one mark");
  assert.equal((await store.agents.list()).find((one) => one.id === AGENT)?.deleting, true, "and with the list");
  await store.agents.markDeleting("no-such-agent");
  assert.equal(await store.agents.get("no-such-agent"), undefined, "an agent not there is no write");

  await assert.rejects(store.runs.createInline(inline("run-b", "key-b")), AgentDeleting, "an inline run of it");
  await assert.rejects(store.runs.create({ id: "run-c", agentId: AGENT, revisionId: "rev-9" }, { body: { input: { content: "hi" } } }), AgentDeleting, "a run of it");
  await assert.rejects(store.runs.reopen("run-a", { kind: "steer", body: { text: "And eight?" } }), AgentDeleting, "a follow-up opening its run again");
  assert.deepEqual((await store.runs.every(AGENT)).map((run) => [run.id, run.state]), [["run-a", "ended"]], "no run was written, and its run is as it ended");
  assert.equal(await store.runOfOrigin("key-b"), undefined, "nor an origin");
  assert.deepEqual(await store.commands("run-a", 0), [], "nor a command");

  // An agent archived and not marked is no delete's: its refusal stays the server's (needRunnableAgent), as before, and a
  // trigger made off for it stays allowed.
  await agentWithRevision(store, "local-1", "rev-local");
  await store.agents.archive("local-1", true);
  assert.equal((await store.agents.get("local-1")).deleting, false, "an archive is no mark");
  assert.equal((await store.runs.create({ id: "run-local", agentId: "local-1", revisionId: "rev-local" })).id, "run-local");
  await store.triggers.create(schedule("trig-local", "local-1", false));
  // An agent made here, marked, is refused as another system's is.
  await agentWithRevision(store, "local-2", "rev-local-2");
  await store.agents.markDeleting("local-2");
  await assert.rejects(store.runs.create({ id: "run-local-2", agentId: "local-2", revisionId: "rev-local-2" }), AgentDeleting, "a run of an agent made here, marked");
  await assert.rejects(store.triggers.create(schedule("trig-local-2", "local-2", false)), AgentDeleting, "a trigger of it");
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
  await store.agents.markDeleting(AGENT);

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

test("runs.every names every run of the agent; runs.remove refuses a run not final and removes a final one's rows; agents.remove refuses while a run remains, then removes the agent; a late write under a removed run's claim writes nothing", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.createInline(inline("run-a", "key-a"));
  // Its end keeps its learning.
  const stale = await end(store, "run-a", { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "dropped", reason: "empty", detail: "Nothing new to keep from this run." } } }] });
  await store.runs.createInline(inline("run-b"));
  await store.command("run-b", { kind: "cancel", body: {} });
  await store.triggers.create({ id: "trig-9", agentId: AGENT, name: "nightly", enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: AGENT, input: { content: "Answer." } }, nextAt: null, catchupWindowS: 0 });

  const every = await store.runs.every(AGENT);
  assert.deepEqual(every.map((run) => run.id).sort(), ["run-a", "run-b"]);

  await assert.rejects(store.runs.remove("run-b"), StoreConstraint, "a queued run is not removed");
  await assert.rejects(store.agents.remove(AGENT), StoreConstraint, "an agent with runs is not removed");
  assert.equal((await store.runs.get("run-b")).state, "queued", "nothing written");
  assert.ok(await store.agents.get(AGENT));

  await end(store, "run-b", { state: "stopped", outcome: "cancelled" });
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

/** A delete's host over the real store, the server's things outside the store left out: the mark, then the archive (as
 *  the trigger engine's agentArchived writes it), a cancel is a cancel command the runner then ends the run on, a trigger
 *  is removed by the store, the runs made from a run are the store's (the server adds its audit's shadow run), its
 *  grades are dropped as the server drops them. `crashAt` throws at that step's point once, as a crash there would stop
 *  the delete. */
function storeHost(store, crashAt) {
  const learning = [];
  const crash = { done: false };
  const host = {
    store,
    deleteLearning: async (given, agentId) => {
      const going = (await given.runs.every(agentId)).filter((run) => !["ended", "stopped", "failed"].includes(run.state));
      learning.push({ refusing: (await given.agents.get(agentId))?.deleting === true, going: going.length });
    },
    refuse: async (agentId) => {
      await store.agents.markDeleting(agentId);
      await store.agents.archive(agentId, true);
    },
    madeFrom: (runId) => store.runs.madeFrom(runId),
    forgetGrades: (agentId, runId) => dropGrades(store.settings, agentId, runId),
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
    const { deleteAgent } = await import("../dist/agent-delete.js");
    const { store } = await storeOn(t);
    await store.runs.createInline(inline("run-a", "key-a"));
    await end(store, "run-a");
    await store.runs.createInline(inline("run-b"));
    await store.triggers.create({ id: "trig-9", agentId: AGENT, name: "nightly", enabled: true, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: AGENT, input: { content: "Answer." } }, nextAt: Date.now() + 600_000, catchupWindowS: 0 });

    const { host, learning, crash } = storeHost(store, step);
    await assert.rejects(deleteAgent(host, AGENT), new RegExp(`stopped ${step}`));
    assert.ok(crash.done);
    assert.equal((await store.agents.get(AGENT))?.deleting, true, "the agent is there, marked");
    assert.equal((await store.runs.get("run-b")).state, "stopped", "its run going was stopped");
    assert.equal(learning.length, step === "after_step_1" ? 0 : 1);
    assert.equal((await store.triggers.list(AGENT)).length, step === "in_step_3" ? 0 : 1, step === "in_step_3" ? "its trigger went first in step 3" : "its trigger is kept to step 3");
    if (step === "in_step_3") assert.equal(await store.runs.get("run-a"), undefined, "and its first run");
    await assert.rejects(store.runs.createInline(inline("run-c")), AgentDeleting, "it refuses an inline run");
    await assert.rejects(store.runs.create({ id: "run-d", agentId: AGENT, revisionId: "rev-9" }), AgentDeleting, "and a run");

    await deleteAgent(host, AGENT);
    assert.deepEqual(learning.at(-1), { refusing: true, going: 0 }, "its learning deleted with it refusing and none going");
    assert.equal(await store.agents.get(AGENT), undefined, "the agent is gone");
    assert.deepEqual(await store.runs.every(AGENT), [], "its runs");
    assert.deepEqual(await store.triggers.list(AGENT), [], "its trigger");
    assert.deepEqual(await store.agents.revisions(AGENT), [], "its revisions");
    assert.equal(await store.runOfOrigin("key-a"), undefined, "its run's origin");
  });
}

/** Every place in the store at `place` that holds `id`: `table.column` of each row whose value has it, over every table its
 *  schema lists (SQLite's tables, or the Postgres schema's), read row by row. */
async function mentions(place, id) {
  const db = await raw(place, { readOnly: true });
  try {
    const tables = db.kind === "sqlite"
      ? await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      : await db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1");
    assert.ok(tables.length > 10, `the schema's tables are listed: ${tables.length}`);
    const found = new Set();
    for (const { name } of tables) {
      for (const row of await db.all(`SELECT * FROM ${name}`)) {
        for (const [column, value] of Object.entries(row)) {
          const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
          if (text?.includes(id)) found.add(`${name}.${column}`);
        }
      }
    }
    return [...found].sort();
  } finally {
    await db.close();
  }
}

/** A grade of run `run`, as the grade route keeps one. */
const grade = (run) => ({ run, correct: true, source: "feedback", at: new Date(T).toISOString(), path: "agent" });
const T = Date.parse("2026-11-08T05:00:00Z");

test("after a run's delete no table of the store names it, nor the runs made from it (listed from the schema); its sibling and another agent's run keep every row", async (t) => {
  const { deleteRun } = await import("../dist/agent-delete.js");
  const { store, file } = await storeOn(t);
  // The run: its origin, launch, a command, its journal, its kept learning (which names a learning run), its run change.
  await store.runs.createInline(inline("run-r7", "key-r7"));
  await store.command("run-r7", { kind: "cancel", body: {} });
  const claim = await store.claim("run-r7", "runner-a", { leaseMs: 30_000 });
  await commitWrites(store.journal(claim), [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  await store.runs.update(claim, { state: "stopped", outcome: "cancelled" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "dropped", reason: "empty", detail: "Nothing new to keep from this run." } } }] });
  // The runs made from it: a replay of its input, and the learning run its kept learning names.
  await store.runs.create({ id: "run-p7", agentId: AGENT, revisionId: "rev-9" }, { body: { input: { content: "What is six times seven?" }, replay: { of: "run-r7" } } });
  await end(store, "run-p7");
  await store.runs.create({ id: "run-l7", agentId: AGENT, revisionId: "rev-9" }, { body: { input: { content: "Learn." } } });
  await end(store, "run-l7");
  // Its sibling, and another agent's run, each with the same kinds of rows.
  await store.runs.createInline(inline("run-k7", "key-k7"));
  await store.command("run-k7", { kind: "cancel", body: {} });
  await end(store, "run-k7", { state: "stopped", outcome: "cancelled" });
  await agentWithRevision(store, "other-7", "rev-o7");
  await store.runs.create({ id: "run-o7", agentId: "other-7", revisionId: "rev-o7" }, { body: { input: { content: "Hi." }, replay: { of: "run-k7" } } });
  await store.command("run-o7", { kind: "cancel", body: {} });
  await end(store, "run-o7", { state: "stopped", outcome: "cancelled" });
  // A trigger whose last run it was, a firing that started it and one that waits behind it; its grade and its sibling's.
  await store.triggers.create(schedule("trig-r7", AGENT, false));
  const db = await raw(file);
  try {
    await db.run("UPDATE learning_proposals SET learning_run_id = ? WHERE run_id = ?", "run-l7", "run-r7");
    await db.run("UPDATE triggers SET last_run_id = ? WHERE id = ?", "run-r7", "trig-r7");
    await db.run("INSERT INTO trigger_firings (trigger_id, key, status, at, run_id) VALUES (?, ?, 'started', ?, ?)", "trig-r7", "fired-r7", T, "run-r7");
    await db.run("INSERT INTO trigger_firings (trigger_id, key, status, at, waits_on) VALUES (?, ?, 'due', ?, ?)", "trig-r7", "waits-r7", T, "run-r7");
  } finally {
    await db.close();
  }
  for (const run of ["run-r7", "run-k7"]) await putGrade(store.settings, AGENT, grade(run));
  assert.deepEqual((await store.runs.madeFrom("run-r7")).sort(), ["run-l7", "run-p7"], "the runs made from it");
  assert.deepEqual(await store.runs.madeFrom("run-p7"), [], "a run made from none");
  for (const id of ["run-r7", "run-p7", "run-l7"]) assert.ok((await mentions(file, id)).includes("runs.id"), `run ${id} is in the store`);
  const before = { k7: await mentions(file, "run-k7"), o7: await mentions(file, "run-o7") };

  await deleteRun(storeHost(store).host, "run-r7");

  for (const id of ["run-r7", "run-p7", "run-l7"]) assert.deepEqual(await mentions(file, id), [], `no table names ${id}`);
  // Its sibling and the other agent's run keep every row (the replay of the sibling still names it in its launch).
  assert.deepEqual(await mentions(file, "run-k7"), before.k7, "its sibling keeps every row");
  assert.deepEqual(await mentions(file, "run-o7"), before.o7, "another agent's run keeps every row");
  assert.deepEqual((await gradesOf(store.settings, AGENT)).map((one) => one.run), ["run-k7"], "its grade is dropped, its sibling's kept");
  assert.deepEqual((await store.triggers.get("trig-r7")).lastRunId ?? null, null, "the trigger keeps no link to it");
  assert.ok(await store.agents.get(AGENT), "its agent is kept");
  assert.deepEqual((await store.runs.every(AGENT)).map((run) => run.id), ["run-k7"]);
  await assert.rejects(deleteRun(storeHost(store).host, "run-r7"), (error) => error.code === "not_found");
});

test("agents.remove takes the agent's delete mark and the answer a template apply kept naming it; another agent's are kept", async (t) => {
  const { store, file } = await storeOn(t);
  for (const id of ["agent-m", "agent-n"]) {
    await agentWithRevision(store, id, `rev-${id}`);
    await store.agents.markDeleting(id);
  }
  const db = await raw(file);
  try {
    for (const id of ["agent-m", "agent-n"]) await db.run("INSERT INTO idempotency (scope, key, response, at) VALUES ('templates.apply', ?, ?, ?)", `key-${id}`, JSON.stringify({ agentId: id, triggers: [] }), T);
  } finally {
    await db.close();
  }
  await store.agents.remove("agent-m");
  assert.deepEqual(await mentions(file, "agent-m"), [], "no table names the agent");
  assert.ok((await mentions(file, "agent-n")).includes("idempotency.response"), "another agent's kept answer stays");
  assert.equal((await store.agents.get("agent-n")).deleting, true, "and its mark");
});
