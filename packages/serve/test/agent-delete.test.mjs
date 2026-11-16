// DELETE /v2/agents/{agent_id}: an agent another system owns (made by an inline run, POST /runs with `external`) deleted
// whole, for a host with a data-deletion duty. In order: the agent refuses new runs (a state in the store, so it outlives a
// restart) and its runs in flight and its learning work are stopped through the cancel path, each waited for until it is
// terminal; then its learning (deleteLearning, the learning module's, injected here as a fake that records its calls); then
// its rows: its runs and everything kept by them, its triggers, its revisions and the agent. 204 when done; 404 for an
// unknown agent, and for a second DELETE after one that finished; 409 for an agent made here (archive it instead); 409
// learning_busy while learning work is in flight, the agent left refusing runs. A DELETE stopped at any step (a crash) is
// finished by the next one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const DEFINITION = { name: "Expert 9", description: "Answers questions.", instructions: "Answer.", skills: [], tools: [] };
const external = (id = "9", version = 1) => ({ source: "host", kind: "expert", id, version });
const inline = (content, id = "9") => ({ external: external(id), definition: DEFINITION, input: { content } });

/** The fake deleteLearning: records each call (`calls`, in order with `order`), and refuses while `busy` is set, as the real
 *  one refuses while learning work is in flight. */
function fakeLearning(order = []) {
  const state = { calls: [], busy: false, order, seen: [] };
  state.deleteLearning = async (store, agentId) => {
    assert.ok(store && typeof store.runs?.get === "function", "deleteLearning is given the server's store");
    // What it is called on: the agent still there, refusing runs, none of its runs going (step 1 done, step 3 not begun).
    const row = await store.agents.get(agentId);
    const going = (await store.runs.every(agentId)).filter((run) => !["ended", "stopped", "failed"].includes(run.state));
    state.seen.push({ agent: row !== undefined, refusing: row?.archivedAt != null, going: going.length, triggers: (await store.triggers.list(agentId)).length });
    state.calls.push(agentId);
    order.push(`learning:${agentId}`);
    if (state.busy) throw new Error("learning work in flight");
  };
  return state;
}

/** The agent's folder's name on the disk (workspace/paths.ts agentDirName). */
const agentDir = (id) => `${id.toLowerCase()}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;

/** How many rows each table keeps of the agent and of its runs, read from the store's file directly. */
function rowsOf(data, agentId, runIds) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n);
    const byRun = (table, column = "run_id") => runIds.reduce((sum, id) => sum + count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, id), 0);
    return {
      agents: count("SELECT COUNT(*) AS n FROM agents WHERE id = ?", agentId),
      revisions: count("SELECT COUNT(*) AS n FROM revisions WHERE agent_id = ?", agentId),
      // Every run of the agent, its built-in learning runs included, and the runs named, whatever agent they name.
      runs: count("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?", agentId),
      named: byRun("runs", "id"),
      triggers: count("SELECT COUNT(*) AS n FROM triggers WHERE agent_id = ?", agentId),
      launches: byRun("run_launch"),
      commands: byRun("commands"),
      origins: byRun("run_origins"),
      changes: byRun("run_changes"),
      journal: byRun("pi_entries") + byRun("pi_metadata") + byRun("pi_tasks"),
      proposals: count("SELECT COUNT(*) AS n FROM learning_proposals WHERE agent_id = ?", agentId),
    };
  } finally {
    db.close();
  }
}

const NONE = { agents: 0, revisions: 0, runs: 0, named: 0, triggers: 0, launches: 0, commands: 0, origins: 0, changes: 0, journal: 0, proposals: 0 };

/** An external agent with a finished run, a running run, a trigger and a revision; answers their ids. */
async function populated(api) {
  const done = await api("POST", "/runs", inline("What is six times seven?"), { "idempotency-key": "delete-me-once" });
  assert.equal(done.status, 202, JSON.stringify(done.body));
  await follow(api, done.body.run_id, ["completed"]);
  const live = await api("POST", "/runs", inline("Take your time."));
  assert.equal(live.status, 202, JSON.stringify(live.body));
  await follow(api, live.body.run_id, ["working"]);
  const agentId = done.body.agent_id;
  const trigger = await api("POST", "/triggers", { name: "nightly", source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: agentId, input: { content: "Answer soon." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  return { agentId, revision: done.body.revision, runs: [done.body.run_id, live.body.run_id], trigger: trigger.body.id };
}

test("DELETE /agents/{id} removes an external agent's runs, finished and running, its trigger, its revisions and the agent; a second DELETE is 404", { timeout: 180_000 }, async (t) => {
  const learning = fakeLearning();
  const { api, data } = await serve(t, { deleteLearning: learning.deleteLearning });
  const { agentId, runs, trigger } = await populated(api);
  const before = rowsOf(data, agentId, runs);
  assert.ok(before.agents === 1 && before.revisions === 1 && before.named === 2 && before.runs >= 2 && before.triggers === 1 && before.launches === 2 && before.journal > 0, JSON.stringify(before));
  assert.ok(existsSync(join(data, "disk", "agents", agentDir(agentId))), "the agent has a folder on the disk");

  const deleted = await api("DELETE", `/agents/${agentId}`);
  assert.equal(deleted.status, 204, `DELETE /agents/{id}: ${deleted.status} ${JSON.stringify(deleted.body)}`);
  assert.deepEqual(learning.calls, [agentId], "the agent's learning deleted once");
  assert.deepEqual(learning.seen, [{ agent: true, refusing: true, going: 0, triggers: 1 }], "after its runs stopped, before its things went");

  assert.equal((await api("GET", `/agents/${agentId}`)).status, 404);
  for (const id of runs) assert.equal((await api("GET", `/runs/${id}`)).status, 404, `run ${id} is gone`);
  assert.equal((await api("GET", `/triggers/${trigger}`)).status, 404, "its trigger is gone");
  assert.deepEqual(rowsOf(data, agentId, runs), NONE, "no row of the agent or its runs is left");
  assert.ok(!existsSync(join(data, "disk", "agents", agentDir(agentId))), "its folder on the disk is gone");
  assert.ok(!existsSync(join(data, "scratch", agentDir(agentId))), "its scratch folders are gone");

  // The idempotency key its first run was made under answers nothing of it any more: the same key starts a new agent.
  const again = await api("POST", "/runs", inline("What is six times seven?"), { "idempotency-key": "delete-me-once" });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.notEqual(again.body.agent_id, agentId, "a new agent for the same reference, not the deleted one");
  assert.equal(again.headers.get("idempotent-replayed"), null, "not a replay of the deleted run's answer");
  await follow(api, again.body.run_id, ["completed"]);

  const second = await api("DELETE", `/agents/${agentId}`);
  assert.deepEqual([second.status, second.body.error?.code], [404, "not_found"]);
});

/** The agent refuses each way a run of it would start: an inline run, a run, and a message that would open its finished
 *  run `finished` again (when that run is still there): 409 agent_not_runnable, in words. An inline run is refused before
 *  anything of it is prepared, so one naming a file that is not there is refused the same way, not checked first. */
async function refusesRuns(api, agentId, finished) {
  const refused = [
    await api("POST", "/runs", inline("Another question.")),
    await api("POST", "/runs", { ...inline("Another question."), file_ids: ["file-not-there"] }),
    await api("POST", `/agents/${agentId}/runs`, { input: { content: "Another question." } }),
    ...(finished ? [await api("POST", `/runs/${finished}/messages`, { content: "And six times eight?" })] : []),
  ];
  for (const answer of refused) {
    assert.deepEqual([answer.status, answer.body.error?.code], [409, "agent_not_runnable"], JSON.stringify(answer.body));
    assert.match(answer.body.error.message, /being deleted/);
  }
  if (finished) assert.equal((await api("GET", `/runs/${finished}`)).body.status, "completed", "its finished run was not opened again");
}

for (const step of ["after_step_1", "after_step_2", "in_step_3"]) {
  test(`a DELETE stopped ${step.replaceAll("_", " ")} leaves the agent refusing runs${step === "after_step_1" ? ", across a restart" : ""}; the next DELETE finishes it`, { timeout: 240_000 }, async (t) => {
    const learning = fakeLearning();
    const crash = { done: false };
    const options = {
      deleteLearning: learning.deleteLearning,
      agentDeleteAt: (at) => {
        if (at !== step || crash.done) return;
        crash.done = true;
        throw new Error(`stopped ${at}`);
      },
    };
    const first = await serve(t, options);
    const { agentId, runs, trigger } = await populated(first.api);
    const stopped = await first.api("DELETE", `/agents/${agentId}`);
    assert.deepEqual([stopped.status, stopped.body.error?.code], [500, "internal"], JSON.stringify(stopped.body));
    assert.ok(crash.done, "it stopped where it was told to");

    // A restart between: the mark is in the store, so the server started next refuses as this one did.
    const { api, data } = step === "after_step_1" ? (await first.stop(), await serve(t, { ...options, data: first.data })) : first;
    assert.equal(learning.calls.length, step === "after_step_1" ? 0 : 1, "its learning deleted from step 2 on");
    const left = rowsOf(data, agentId, runs);
    assert.equal(left.agents, 1, "the agent is still there");
    if (step === "in_step_3") {
      assert.equal(left.triggers, 0, "its trigger went first in step 3");
      assert.equal((await api("GET", `/runs/${runs[0]}`)).status, 404, "and its first run");
      await refusesRuns(api, agentId);
    } else {
      assert.equal(left.triggers, 1);
      assert.equal((await api("GET", `/triggers/${trigger}`)).body.enabled, false, "its trigger is off");
      assert.equal((await api("GET", `/runs/${runs[1]}`)).body.status, "cancelled", "its running run was cancelled");
      await refusesRuns(api, agentId, runs[0]);
    }

    const finished = await api("DELETE", `/agents/${agentId}`);
    assert.equal(finished.status, 204, JSON.stringify(finished.body));
    assert.deepEqual(rowsOf(data, agentId, runs), NONE, "no row of the agent or its runs is left");
    assert.ok(!existsSync(join(data, "disk", "agents", agentDir(agentId))), "nor its folder");
    assert.equal(learning.calls.length, step === "after_step_1" ? 1 : 2, "its learning delete called again: it is idempotent");
    assert.deepEqual([(await api("DELETE", `/agents/${agentId}`)).status], [404]);
  });
}

test("deleteLearning's refusal is 409 learning_busy, the agent left refusing runs with its runs stopped; once it lets go, the DELETE finishes", { timeout: 180_000 }, async (t) => {
  const learning = fakeLearning();
  learning.busy = true;
  const { api, data } = await serve(t, { deleteLearning: learning.deleteLearning });
  const { agentId, runs, trigger } = await populated(api);
  const busy = await api("DELETE", `/agents/${agentId}`);
  assert.deepEqual([busy.status, busy.body.error?.code, busy.body.error?.retryable], [409, "learning_busy", true], JSON.stringify(busy.body));
  assert.match(busy.body.error.message, /learning work in flight/);
  assert.deepEqual(learning.seen, [{ agent: true, refusing: true, going: 0, triggers: 1 }]);
  await refusesRuns(api, agentId, runs[0]);
  assert.equal((await api("GET", `/triggers/${trigger}`)).body.enabled, false);
  const left = rowsOf(data, agentId, runs);
  assert.ok(left.agents === 1 && left.named === 2 && left.triggers === 1, JSON.stringify(left));

  learning.busy = false;
  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.deepEqual(learning.calls, [agentId, agentId]);
  assert.deepEqual(rowsOf(data, agentId, runs), NONE);
});

test("a server with no learning delete deletes no agent: 501, nothing touched", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  const made = await api("POST", "/runs", inline("What is six times seven?"));
  assert.equal(made.status, 202);
  const refused = await api("DELETE", `/agents/${made.body.agent_id}`);
  assert.deepEqual([refused.status, refused.body.error?.code], [501, "unsupported_here"], JSON.stringify(refused.body));
  assert.equal((await api("GET", `/agents/${made.body.agent_id}`)).body.archived_at ?? null, null, "not marked");
});

test("an agent made here is not deleted: 409 that points at archive, nothing touched", { timeout: 60_000 }, async (t) => {
  const learning = fakeLearning();
  const { api } = await serve(t, { runner: false, deleteLearning: learning.deleteLearning });
  assert.equal((await api("POST", "/agents", agent("local-1"))).status, 201);
  const refused = await api("DELETE", "/agents/local-1");
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "agent_not_external"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /archive/);
  assert.equal(learning.calls.length, 0);
  assert.equal((await api("GET", "/agents/local-1")).status, 200);
  const unknown = await api("DELETE", "/agents/no-such-agent");
  assert.deepEqual([unknown.status, unknown.body.error?.code], [404, "not_found"]);
});
