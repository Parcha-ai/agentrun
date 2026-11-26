// DELETE /v2/agents/{agent_id}: an agent another system owns (made by an inline run, POST /runs with `external`) deleted
// whole, for a host with a data-deletion duty. In order: the agent refuses new runs (a state in the store, so it outlives a
// restart) and its runs in flight and its learning work are stopped through the cancel path, each waited for until it is
// terminal; then its learning (the learning module's deleteLearning, the server's own unless a test injects a fake that
// records its calls); then its rows: its runs and everything kept by them, its triggers, its revisions and the agent. 204
// when done; 404 for an unknown agent, and for a second DELETE after one that finished; 409 agent_not_archived for an
// agent made here not archived (agent-purge.test.mjs purges one archived); 409 learning_busy while learning work is in flight, the agent left refusing runs. A DELETE stopped
// at any step (a crash) is finished by the next one.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agentDiskKey, keepRunDisk, runDiskKey, saveArchilSettings, storeAgentDisk } from "../dist/archil-settings.js";
import { LearningInFlight } from "../dist/learn/delete.js";
import { saveSignIn } from "../dist/sign-ins-store.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { FakeArchilDisk, FakeDiskError } from "./fixtures/archil-fake.mjs";
import { calls as bbCalls, contexts, deleteFailures, KEY as BB_KEY } from "./fixtures/faux-browserbase-check.mjs";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { raw } from "./store-target.mjs";
import { agent, follow, secretWritePath, serve, withEnv } from "./support.mjs";
import { putLearning } from "./learn-support.mjs";

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);
const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;

const DEFINITION = { name: "Expert 9", description: "Answers questions.", instructions: "Answer.", skills: [], tools: [] };
const external = (id = "9", version = 1) => ({ source: "host", kind: "expert", id, version });
const inline = (content, id = "9") => ({ external: external(id), definition: DEFINITION, input: { content } });

/** A fake deleteLearning, for the tests that count its calls or hold the delete at step 2: records each call (`calls`, in
 *  order with `order`), and refuses while `busy` is set (LearningInFlight), as the real one refuses while learning work is
 *  in flight; `fails` throws another error. */
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
    if (state.busy) throw new LearningInFlight(agentId, ["a-run-in-flight"]);
    if (state.fails) throw new Error("the learning rows could not be read");
  };
  return state;
}

/** What the agent's learning keeps: its rows (its corrections.md and a workflow saved), and a promotion, a grade and an
 *  audit record. */
async function learned(store, agentId) {
  await putLearning(store, agentId, { "corrections.md": "- Six times seven is 42.", "workflows/multiply/workflow.json": "{}", "workflows/multiply/README.md": "---\nname: multiply\ndescription: Multiplies\n---\n" }, { runId: "run-learned" });
  // Each record names the digest the saved version holds (a record of one no version holds is refused).
  const digest = (await store.learning.versions(agentId, "workflow", "multiply"))[0].digest;
  await store.learning.addRecord(agentId, "promotion", { runId: null, workflow: "multiply", digest, data: { workflow: "multiply", digest, decided: "promote", at: new Date(0).toISOString(), reason: "checked" } });
  await store.learning.addRecord(agentId, "grade", { runId: "r1", workflow: null, digest: null, data: { run: "r1", correct: true } });
  await store.learning.addRecord(agentId, "audit", { runId: "r1", workflow: "multiply", digest, data: {} });
}

/** The kinds of learning row the store still keeps of the agent (none once its learning is deleted): its saves, then
 *  each kind of record. */
async function recordsOf(store, agentId) {
  const left = [];
  if ((await store.learning.saves(agentId)).total) left.push("saves");
  for (const kind of ["promotion", "grade", "audit"]) if ((await store.learning.records(agentId, kind)).length) left.push(kind);
  return left;
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
  const { api, data, store } = await serve(t);
  const { agentId, runs, trigger } = await populated(api);
  // The disk its first run resolved to, as a run in Archil mode keeps it (archil-settings.ts keepRunDisk).
  await keepRunDisk(store, runs[0], "dsk-c0570000000000c1");
  const before = rowsOf(data, agentId, runs);
  assert.ok(before.agents === 1 && before.revisions === 1 && before.named === 2 && before.runs >= 2 && before.triggers === 1 && before.launches === 2 && before.journal > 0, JSON.stringify(before));
  assert.ok(existsSync(join(data, "disk", "agents", agentDir(agentId))), "the agent has a folder on the disk");

  const deleted = await api("DELETE", `/agents/${agentId}`);
  assert.equal(deleted.status, 204, `DELETE /agents/{id}: ${deleted.status} ${JSON.stringify(deleted.body)}`);

  assert.equal((await api("GET", `/agents/${agentId}`)).status, 404);
  for (const id of runs) assert.equal((await api("GET", `/runs/${id}`)).status, 404, `run ${id} is gone`);
  assert.equal((await api("GET", `/triggers/${trigger}`)).status, 404, "its trigger is gone");
  assert.deepEqual(rowsOf(data, agentId, runs), NONE, "no row of the agent or its runs is left");
  assert.ok(!existsSync(join(data, "disk", "agents", agentDir(agentId))), "its folder on the disk is gone");
  assert.ok(!existsSync(join(data, "scratch", agentDir(agentId))), "its scratch folders are gone");
  assert.equal(await store.settings.get(runDiskKey(runs[0])), undefined, "its run's disk setting is gone");

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

for (const step of ["after_step_1", "after_step_2", "in_step_3_trigger", "in_step_3_trigger_settings", "in_step_3"]) {
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

/** Run `runId`'s state written straight into the store's file: a test's stand-in for a run of the agent open again when its
 *  learning is deleted (the store refuses every way one could open once the agent is marked, so only a write under it does).
 *  Through raw(): the server's transaction finishes only while this thread is free, so the write waits on a worker. */
async function stateOf(data, runId, state) {
  const db = await raw(join(data, "store.sqlite"), { timeout: 15_000 });
  try {
    await db.run("UPDATE runs SET state = ? WHERE id = ?", state, runId);
  } finally {
    await db.close();
  }
}

test("the server's own learning delete: the agent's learning rows gone (its saves, its promotions, grades and audits), after its runs stopped and before its other things went; 204", { timeout: 180_000 }, async (t) => {
  const at = { seen: [] };
  const { api, data, store } = await serve(t, {
    agentDeleteAt: async (step, agentId) => {
      if (step !== "after_step_2") return;
      at.seen.push({ records: await recordsOf(at.store, agentId), agentFolder: existsSync(join(at.data, "disk", "agents", agentDir(agentId))) });
    },
  });
  Object.assign(at, { data, store });
  const { agentId, runId } = await finishedAgent(api);
  await learned(store, agentId);
  assert.deepEqual(await recordsOf(store, agentId), ["saves", "promotion", "grade", "audit"]);

  const deleted = await api("DELETE", `/agents/${agentId}`);
  assert.equal(deleted.status, 204, `DELETE /agents/{id} with the server's own learning delete: ${deleted.status} ${JSON.stringify(deleted.body)}`);
  // At step 2's end the learning module has done its part (its rows gone), the agent's folder kept.
  assert.deepEqual(at.seen, [{ records: [], agentFolder: true }], "the learning deleted by step 2, the rest after");
  assert.deepEqual(await recordsOf(store, agentId), [], "no learning record of the agent is left");
  assert.deepEqual(rowsOf(data, agentId, [runId]), NONE);
  assert.deepEqual([(await api("DELETE", `/agents/${agentId}`)).status], [404]);
});

test("a run of the agent open when its learning is deleted: the learning module refuses, 409 learning_busy naming the run, the agent kept and refusing runs with its learning kept; once the run has ended, the DELETE finishes", { timeout: 180_000 }, async (t) => {
  const open = { runId: undefined };
  const { api, data, store } = await serve(t, {
    agentDeleteAt: async (step) => {
      if (step !== "after_step_1" || open.runId === undefined) return;
      await stateOf(open.data, open.runId, "parked");
      open.runId = undefined;
    },
  });
  open.data = data;
  const { agentId, runs, trigger } = await populated(api);
  await learned(store, agentId);
  open.runId = runs[0];
  const busy = await api("DELETE", `/agents/${agentId}`);
  assert.deepEqual([busy.status, busy.body.error?.code, busy.body.error?.retryable], [409, "learning_busy", true], JSON.stringify(busy.body));
  assert.match(busy.body.error.message, new RegExp(`learning is at work in ${runs[0]}`));
  assert.deepEqual(busy.body.error.details?.runs, [runs[0]], "the run in flight named");
  assert.equal((await api("GET", `/agents/${agentId}`)).status, 200, "the agent is kept");
  assert.equal((await api("GET", `/triggers/${trigger}`)).body.enabled, false);
  assert.deepEqual(await recordsOf(store, agentId), ["saves", "promotion", "grade", "audit"], "nothing of its learning removed");
  const left = rowsOf(data, agentId, runs);
  assert.ok(left.agents === 1 && left.named === 2 && left.triggers === 1, JSON.stringify(left));

  await stateOf(data, runs[0], "ended");
  await refusesRuns(api, agentId, runs[0]);
  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.deepEqual(rowsOf(data, agentId, runs), NONE);
  assert.deepEqual(await recordsOf(store, agentId), []);
});

test("a learning delete that fails for another reason than work in flight is 500 internal, never learning_busy; the agent is kept refusing runs, and the next DELETE finishes", { timeout: 120_000 }, async (t) => {
  const learning = fakeLearning();
  learning.fails = true;
  const { api, data } = await serve(t, { deleteLearning: learning.deleteLearning });
  const { agentId, runId } = await finishedAgent(api);
  const failed = await api("DELETE", `/agents/${agentId}`);
  assert.deepEqual([failed.status, failed.body.error?.code], [500, "internal"], JSON.stringify(failed.body));
  await refusesRuns(api, agentId, runId);
  learning.fails = false;
  assert.equal((await api("DELETE", `/agents/${agentId}`)).status, 204);
  assert.deepEqual(rowsOf(data, agentId, [runId]), NONE);
});

test("an agent made here, not archived, is not purged: 409 agent_not_archived that points at archive, nothing touched", { timeout: 60_000 }, async (t) => {
  const learning = fakeLearning();
  const { api } = await serve(t, { runner: false, deleteLearning: learning.deleteLearning });
  assert.equal((await api("POST", "/agents", agent("local-1"))).status, 201);
  const refused = await api("DELETE", "/agents/local-1");
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "agent_not_archived"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /archive/);
  assert.equal(learning.calls.length, 0);
  assert.equal((await api("GET", "/agents/local-1")).status, 200);
  const unknown = await api("DELETE", "/agents/no-such-agent");
  assert.deepEqual([unknown.status, unknown.body.error?.code], [404, "not_found"]);
});

/** An external agent with one finished run: its id and the run's. */
async function finishedAgent(api, id = "9") {
  const done = await api("POST", "/runs", inline("What is six times seven?", id));
  assert.equal(done.status, 202, JSON.stringify(done.body));
  await follow(api, done.body.run_id, ["completed"]);
  return { agentId: done.body.agent_id, runId: done.body.run_id };
}

/** A DELETE that stopped because something the agent owns elsewhere is not deleted there yet: 503 unavailable, retryable,
 *  in words that say to send it again, with the agent still there and refusing runs. */
async function notYet(api, agentId, runId, words) {
  const answer = await api("DELETE", `/agents/${agentId}`);
  assert.deepEqual([answer.status, answer.body.error?.code, answer.body.error?.retryable], [503, "unavailable", true], JSON.stringify(answer.body));
  assert.match(answer.body.error.message, words);
  assert.match(answer.body.error.message, /send the DELETE again/);
  assert.equal((await api("GET", `/agents/${agentId}`)).status, 200, "the agent is kept");
  await refusesRuns(api, agentId, runId);
}

test("an API-only server deletes an external agent: the backend that made it by its inline runs deletes it", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { apiOnly: true });
  const { agentId, runId } = await finishedAgent(api);
  const deleted = await api("DELETE", `/agents/${agentId}`);
  assert.equal(deleted.status, 204, `DELETE /agents/{id} on an API-only server: ${deleted.status} ${JSON.stringify(deleted.body)}`);
  assert.equal((await api("GET", `/runs/${runId}`)).status, 404, "its run is gone");
});

test("a saved sign-in whose vendor delete fails keeps the delete from finishing: 503, the agent kept and refusing runs; the next DELETE deletes it at the vendor, then 204", { timeout: 120_000 }, async (t) => {
  const seal = randomBytes(32).toString("base64");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: seal }, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL", "KERNEL_API_KEY", "AGENTRUN_SEAL_KEY"]);
  const { api, data, store } = await serve(t, { fauxBrowserbase: FAUX_BROWSERBASE });
  const { agentId, runId } = await finishedAgent(api);
  const context = `ctx-delete-${randomBytes(4).toString("hex")}`;
  contexts.add(context);
  await saveSignIn(store, Buffer.from(seal, "base64"), { agentId, provider: "browserbase", pointer: context });
  const deletes = () => bbCalls.filter((call) => call.method === "DELETE" && call.path === `/v1/contexts/${context}`).length;

  deleteFailures.left = 1;
  await notYet(api, agentId, runId, /browserbase/);
  assert.equal(deletes(), 1, "the vendor was asked once");
  assert.ok(contexts.has(context), "and still holds the saved cookies");
  assert.equal(rowsOf(data, agentId, [runId]).agents, 1);

  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.equal(deletes(), 2, "the next DELETE asked the vendor again");
  assert.equal(contexts.has(context), false, "the vendor no longer holds it");
  assert.deepEqual(rowsOf(data, agentId, [runId]), { ...NONE }, "nothing of the agent is left");
});

test("a trigger's registration upstream goes before its row: a Composio failure is 503 with the trigger kept; a stop between the two leaves the row for the next DELETE, which finishes", { timeout: 180_000 }, async (t) => {
  const composio = await startFakeComposio({
    toolkits: { github: { no_auth: false, tools: [{ slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "Lists issues." }] } },
    authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }] },
    active: ["github"],
    fail: { path: (path) => path.startsWith("/api/v3/trigger_instances/manage/"), method: "DELETE", status: 500, times: 1 },
  });
  t.after(() => composio.close());
  const crash = { armed: false, done: false };
  const { api } = await serve(t, {
    publicUrl: "https://agentrun.example.com",
    composioControl: { baseUrl: composio.baseUrl },
    agentDeleteAt: (at) => {
      if (at !== "in_step_3_trigger" || !crash.armed || crash.done) return;
      crash.done = true;
      throw new Error(`stopped ${at}`);
    },
  });
  const saved = await api("PUT", "/settings/mcp-servers/gh/composio", { api_key: composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "agentrun-qa" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const { agentId, runId } = await finishedAgent(api);
  const made = await api("POST", "/triggers", {
    name: "issues",
    source: { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "many-drop", repo: "agentrun-scratch" } },
    target: { kind: "start_run", agent_id: agentId, input: { content: "Triage this issue." }, max_cost_usd: 0.5 },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const instance = made.body.source.instance_id;
  assert.ok(composio.instances.has(instance));

  // Composio fails the delete: the trigger is kept, so the next DELETE finds what is left to remove there.
  await notYet(api, agentId, runId, new RegExp(instance));
  assert.ok(composio.instances.has(instance), "still registered at Composio");
  assert.equal((await api("GET", `/triggers/${made.body.id}`)).status, 200, "the trigger is kept");

  // A stop once Composio removed it and before the row went: the row is still there, and the next DELETE finishes.
  crash.armed = true;
  const stopped = await api("DELETE", `/agents/${agentId}`);
  assert.deepEqual([stopped.status, stopped.body.error?.code], [500, "internal"], JSON.stringify(stopped.body));
  assert.ok(crash.done, "it stopped between Composio and the row");
  assert.equal(composio.instances.has(instance), false, "removed at Composio");
  assert.equal((await api("GET", `/triggers/${made.body.id}`)).status, 200, "the row is kept");

  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.equal((await api("GET", `/triggers/${made.body.id}`)).status, 404, "the trigger is gone");
  assert.equal((await api("GET", `/agents/${agentId}`)).status, 404);
});

test("an agent's stored Archil disk with Archil off keeps the delete from finishing: 503, the agent kept and refusing runs; with Archil on again the next DELETE deletes the disk there, then 204", { timeout: 120_000 }, async (t) => {
  const disk = "dsk-a9de1e7e00000001";
  const control = archilControlFetch({ region: "aws-us-east-1", strict: true, disks: [{ id: disk, name: "its-disk" }] });
  const FAKE_ARCHIL_KEY = "fake-test-key-archil-a9-0001";
  withEnv(t, { ARCHIL_API_KEY: FAKE_ARCHIL_KEY },["ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"]);
  const { api, store } = await serve(t, { archilControl: { baseUrl: control.baseUrl, fetch: control.fetch } });
  const { agentId, runId } = await finishedAgent(api);
  // The disk an earlier Archil mode made for it; Archil was turned off since, which leaves the disk stored on the agent.
  await storeAgentDisk(store, agentId, { diskId: disk });

  await notYet(api, agentId, runId, /Archil is off/);
  assert.ok(control.disks.has(disk), "the disk is still at Archil");
  assert.deepEqual(await store.settings.get(agentDiskKey(agentId)), { diskId: disk }, "and stored on the agent");

  await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.equal(control.disks.has(disk), false, "its disk deleted at Archil");
  assert.equal(await store.settings.get(agentDiskKey(agentId)), undefined);
});

/** Run `runId`'s launch record naming disk `diskId` as the caller's, and the run's disk with it, as POST /runs with
 *  `archil_disk` records them (run-launch.ts: archil_disk { disk_id, kind: "launch" }; runs.disk), written into the
 *  store's file. */
async function launchOnDisk(data, runId, diskId) {
  const db = await raw(join(data, "store.sqlite"), { timeout: 10_000 });
  try {
    const changed = await db.run("UPDATE run_launch SET body = json_set(body, '$.archil_disk', json(?)) WHERE run_id = ?", JSON.stringify({ disk_id: diskId, kind: "launch" }), runId);
    assert.equal(changed.changes, 1, "the run's launch record names the disk");
    assert.equal((await db.run("UPDATE runs SET disk = ? WHERE id = ?", diskId, runId)).changes, 1, "and the run its disk");
  } finally {
    await db.close();
  }
}

test("a run's folder on the Archil disk its launch named (the caller's) is deleted there, the agent's own folder only and never the disk; while Archil refuses, 503 with the agent kept and refusing runs, and the next DELETE finishes", { timeout: 120_000 }, async (t) => {
  const customer = "dsk-c0570e4e00000001";
  const control = archilControlFetch({ region: "aws-us-east-1", strict: true, disks: [{ id: customer, name: "a-customers-disk" }] });
  withEnv(t, { ARCHIL_API_KEY: "fake-test-key" }, ["ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"]);
  // The caller's disk, as the server's file API reaches it (archil-disk.ts): every disk the server makes is this one.
  const disk = new FakeArchilDisk();
  disk.id = customer;
  const made = [];
  const { api, data, store } = await serve(t, { archilControl: { baseUrl: control.baseUrl, fetch: control.fetch, makeDisk: (options) => (made.push(options.disk), disk) } });
  const { agentId, runId } = await finishedAgent(api);
  await launchOnDisk(data, runId, customer);
  await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  // What the run wrote there (its work folder and its exec spill folder, runKey's and spillFolderOf's), beside what is the
  // caller's own and another agent's run.
  const own = `agents/${agentDir(agentId)}`;
  const its = [`${own}/runs/${runId}/work/notes.md`, `${own}/runs/${runId}/work/deep/out.json`, `${own}/runs/${runId}/exec-out/spill.txt`];
  const theirs = ["shared/customers.csv", `agents/${agentDir("another-agent")}/runs/run-other/work/kept.md`];
  for (const key of [...its, ...theirs]) await disk.putObject(key, Buffer.from("bytes"));

  // A computer still holds the run's work folder (Archil's write delegation): its files can't be deleted there yet.
  const release = disk.delegate(`${own}/runs/${runId}/work`);
  await notYet(api, agentId, runId, new RegExp(`${customer}[^]*${runId}|${runId}[^]*${customer}`));
  assert.ok(disk.files.has(its[0]), "the run's file is still on the disk");
  assert.equal(rowsOf(data, agentId, [runId]).launches, 1, "and its launch record, which names the disk, is kept for the next DELETE");

  release();
  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  const left = [...disk.files.keys(), ...disk.dirs].filter((key) => key === own || key.startsWith(`${own}/`));
  assert.deepEqual(left, [], "nothing of the agent is left on the caller's disk, its folders included");
  for (const key of theirs) assert.ok(disk.files.has(key), `${key} is kept: it is not the agent's`);
  assert.ok(control.disks.has(customer), "the caller's disk itself is kept");
  assert.ok(made.length > 0 && made.every((id) => id === customer), `only the run's disk was reached: ${made.join(", ")}`);
  assert.deepEqual(rowsOf(data, agentId, [runId]), NONE);
});

/** `disk`'s file API while Archil's control plane (`control`) holds the disk: once it is deleted there (not there, or read
 *  as deleted), every call fails as S3 answers for a bucket that is not there (404 NoSuchBucket), so no folder on it can be
 *  opened, let alone deleted. */
function goneWithControl(disk, control) {
  return new Proxy(disk, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        if ((control.disks.get(target.id)?.status ?? "deleted") === "deleted") throw new FakeDiskError(404, "NoSuchBucket", `The specified bucket does not exist: ${target.id}`);
        return value.apply(target, args);
      };
    },
  });
}

/** A server in Archil mode, Archil's control plane faked by `control` and every disk's file API by `disk` (as
 *  goneWithControl reaches it), and an external agent with one finished run whose launch named `disk.id`, with a file of
 *  the run's in its folder there. */
async function launchedOn(t, control, disk) {
  withEnv(t, { ARCHIL_API_KEY: "fake-test-key" }, ["ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"]);
  const { api, data, store } = await serve(t, { archilControl: { baseUrl: control.baseUrl, fetch: control.fetch, makeDisk: () => goneWithControl(disk, control) } });
  const { agentId, runId } = await finishedAgent(api);
  await launchOnDisk(data, runId, disk.id);
  await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  await disk.putObject(`agents/${agentDir(agentId)}/runs/${runId}/work/notes.md`, Buffer.from("bytes"));
  return { api, data, store, agentId, runId };
}

test("a run whose launch named the agent's own Archil disk: the disk is deleted at Archil once, the run's folder with it, and the DELETE answers 204", { timeout: 120_000 }, async (t) => {
  const own = "dsk-a9de1e7e00000002";
  const control = archilControlFetch({ region: "aws-us-east-1", strict: true, disks: [{ id: own, name: "its-own-disk" }] });
  const disk = new FakeArchilDisk();
  disk.id = own;
  const { api, data, store, agentId, runId } = await launchedOn(t, control, disk);
  await storeAgentDisk(store, agentId, { diskId: own });

  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  const deletes = control.requests.filter((one) => one.method === "DELETE" && one.path === `/api/disks/${own}`);
  assert.equal(deletes.length, 1, "the agent's disk is deleted at Archil once");
  assert.equal(control.disks.has(own), false);
  assert.equal(await store.settings.get(agentDiskKey(agentId)), undefined);
  assert.deepEqual(rowsOf(data, agentId, [runId]), NONE);
});

test("a run's launch disk the caller deleted before the DELETE (Archil reads it as not there, or as deleted) has nothing left to delete: 204", { timeout: 180_000 }, async (t) => {
  const gone = "dsk-c0570e4e00000002";
  for (const [why, disks] of [["not there", []], ["deleted", [{ id: gone, name: "a-customers-disk", status: "deleted" }]]]) {
    await t.test(why, async (t) => {
      const control = archilControlFetch({ region: "aws-us-east-1", strict: true, disks });
      const disk = new FakeArchilDisk();
      disk.id = gone;
      const { api, data, agentId, runId } = await launchedOn(t, control, disk);

      const done = await api("DELETE", `/agents/${agentId}`);
      assert.equal(done.status, 204, JSON.stringify(done.body));
      assert.ok(control.requests.some((one) => one.method === "GET" && one.path === `/api/disks/${gone}`), "Archil was asked about the disk");
      assert.deepEqual(rowsOf(data, agentId, [runId]), NONE);
    });
  }
});

test("a run's launch disk Archil can't be asked about (500) keeps the delete from finishing: 503, the agent kept and refusing runs with the launch record; once Archil answers that the disk is gone, the next DELETE finishes", { timeout: 120_000 }, async (t) => {
  const gone = "dsk-c0570e4e00000003";
  const failing = { on: true };
  const control = archilControlFetch({
    region: "aws-us-east-1",
    strict: true,
    disks: [],
    answer: ({ method, path }) => (failing.on && method === "GET" && path === `/api/disks/${gone}` ? { status: 500, body: { success: false, error: "internal error", code: "internal" } } : undefined),
  });
  const disk = new FakeArchilDisk();
  disk.id = gone;
  const { api, data, agentId, runId } = await launchedOn(t, control, disk);

  await notYet(api, agentId, runId, new RegExp(gone));
  assert.equal(rowsOf(data, agentId, [runId]).launches, 1, "its launch record, which names the disk, is kept for the next DELETE");

  failing.on = false;
  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.deepEqual(rowsOf(data, agentId, [runId]), NONE);
});

test("a trigger's adapter settings go before its row: a DELETE stopped between the two leaves the row, and the next DELETE removes what is left of both", { timeout: 120_000 }, async (t) => {
  const crash = { done: false };
  const { api, store } = await serve(t, {
    agentDeleteAt: (at) => {
      if (at !== "in_step_3_trigger_settings" || crash.done) return;
      crash.done = true;
      throw new Error(`stopped ${at}`);
    },
  });
  const { agentId, runId } = await finishedAgent(api);
  const made = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: agentId, input: { content: "Triage this event." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const settingsOf = async () => (await store.triggerSettings.get("webhook")).filter((row) => row.scope === made.body.id);
  assert.ok((await settingsOf()).length > 0, "its signing secret is kept in its adapter's settings");

  const stopped = await api("DELETE", `/agents/${agentId}`);
  assert.deepEqual([stopped.status, stopped.body.error?.code], [500, "internal"], JSON.stringify(stopped.body));
  assert.ok(crash.done, "it stopped between the trigger's settings and its row");
  assert.equal((await api("GET", `/triggers/${made.body.id}`)).status, 200, "the row is kept, for the next DELETE to find");
  await refusesRuns(api, agentId, runId);

  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.deepEqual(await settingsOf(), [], "its settings are gone");
  assert.equal((await api("GET", `/triggers/${made.body.id}`)).status, 404, "and its row");
});

/** A fake Composio holding a GitHub toolkit, and a server whose "gh" MCP server is Composio's (as POST /triggers with a
 *  composio source needs), with `options`. */
async function withComposio(t, options) {
  const composio = await startFakeComposio({
    toolkits: { github: { no_auth: false, tools: [{ slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "Lists issues." }] } },
    authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }] },
    active: ["github"],
  });
  t.after(() => composio.close());
  const served = await serve(t, { publicUrl: "https://agentrun.example.com", composioControl: { baseUrl: composio.baseUrl }, ...options });
  const saved = await served.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "agentrun-qa" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { composio, ...served };
}

/** A Composio trigger's body for agent `agentId`, watching repository `repo` (one registration per repository). */
const issuesOf = (agentId, repo, extra = {}) => ({
  name: `issues of ${repo}`,
  source: { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "many-drop", repo } },
  target: { kind: "start_run", agent_id: agentId, input: { content: "Triage this issue." }, max_cost_usd: 0.5 },
  ...extra,
});

/** The refusal of a write to an agent being deleted: 409 agent_not_runnable, in the delete's words. */
function refusedDeleting(answer, what) {
  assert.deepEqual([answer.status, answer.body.error?.code], [409, "agent_not_runnable"], `${what}: ${JSON.stringify(answer.body)}`);
  assert.match(answer.body.error.message, /being deleted/, what);
}

test("an agent being deleted takes no new trigger, off or on, none moved to it and none of its turned on: 409 agent_not_runnable, nothing registered at Composio", { timeout: 180_000 }, async (t) => {
  const learning = fakeLearning();
  learning.busy = true;
  const { api, composio } = await withComposio(t, { deleteLearning: learning.deleteLearning });
  const { agentId } = await finishedAgent(api);
  const other = await api("POST", "/agents", agent("local-1"));
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const own = await api("POST", "/triggers", { name: "nightly", enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: agentId, input: { content: "Answer soon." }, max_cost_usd: 0.5 } });
  const elsewhere = await api("POST", "/triggers", { name: "elsewhere", enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: "local-1", input: { content: "Answer soon." }, max_cost_usd: 0.5 } });
  assert.deepEqual([own.status, elsewhere.status], [201, 201], JSON.stringify([own.body, elsewhere.body]));
  // Marked, and kept there by its learning's refusal.
  assert.equal((await api("DELETE", `/agents/${agentId}`)).status, 409);
  const registered = composio.instances.size;
  const upserts = () => composio.calls.filter((call) => call.path.endsWith("/upsert")).length;
  const asked = upserts();

  refusedDeleting(await api("POST", "/triggers", issuesOf(agentId, "agentrun-scratch", { enabled: false })), "a Composio trigger made off");
  assert.equal(composio.instances.size, registered, "nothing registered at Composio");
  assert.equal(upserts(), asked, "Composio not even asked: refused before anything is registered");
  refusedDeleting(await api("POST", "/triggers", issuesOf(agentId, "agentrun-scratch")), "a Composio trigger made on");
  refusedDeleting(await api("POST", "/triggers", { name: "later", enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: agentId, input: { content: "Answer." }, max_cost_usd: 0.5 } }), "a schedule made off");
  refusedDeleting(await api("PATCH", `/triggers/${elsewhere.body.id}`, { target: { kind: "start_run", agent_id: agentId, input: { content: "Answer." }, max_cost_usd: 0.5 } }), "a trigger moved to it, off");
  refusedDeleting(await api("PATCH", `/triggers/${own.body.id}`, { enabled: true }), "its trigger turned on");
  assert.equal(composio.instances.size, registered, "still nothing registered at Composio");
  assert.deepEqual((await api("GET", "/triggers")).body.triggers.filter((one) => one.target.agent_id === agentId).map((one) => [one.id, one.enabled]), [[own.body.id, false]], "its one trigger, off");
  assert.equal((await api("PATCH", `/triggers/${own.body.id}`, { name: "renamed" })).status, 200, "an edit that leaves it off still lands");

  learning.busy = false;
  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.equal((await api("GET", `/triggers/${elsewhere.body.id}`)).body.target.agent_id, "local-1", "the other agent's trigger is its own still");
});

test("a trigger that reached the agent after the delete listed its triggers stops the delete: 503 with the agent kept and refusing runs; the next DELETE removes it at Composio, then 204", { timeout: 180_000 }, async (t) => {
  // At in_step_3 (the agent's triggers removed), a trigger raced in: written into the store's file as a create that got
  // past every check would have written it, already registered at Composio.
  const race = { done: false };
  const { api, data, composio } = await withComposio(t, {
    agentDeleteAt: async (at, agentId) => {
      if (at !== "in_step_3" || race.done || !race.trigger) return;
      race.done = true;
      const db = await raw(join(race.data, "store.sqlite"), { timeout: 10_000 });
      try {
        const moved = await db.run("UPDATE triggers SET agent_id = ?, target = json_set(target, '$.agent_id', ?) WHERE id = ?", agentId, agentId, race.trigger);
        assert.equal(moved.changes, 1);
      } finally {
        await db.close();
      }
    },
  });
  race.data = data;
  const { agentId, runId } = await finishedAgent(api);
  const { agentId: otherId } = await finishedAgent(api, "10");
  const made = await api("POST", "/triggers", issuesOf(otherId, "agentrun-late", { enabled: false }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const instance = made.body.source.instance_id;
  assert.ok(composio.instances.has(instance), "registered at Composio, though off");
  race.trigger = made.body.id;

  await notYet(api, agentId, undefined, /trigger/);
  assert.ok(race.done, "the trigger raced in after the listing");
  assert.equal(rowsOf(data, agentId, [runId]).named, 0, "its run went before the stop");
  assert.ok(composio.instances.has(instance), "still registered at Composio");
  assert.equal((await api("GET", `/triggers/${made.body.id}`)).status, 200, "the trigger is kept, for the next DELETE to find");

  const done = await api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.equal(composio.instances.has(instance), false, "the next DELETE removed it at Composio");
  assert.equal((await api("GET", `/triggers/${made.body.id}`)).status, 404, "and its row");
  assert.deepEqual(rowsOf(data, agentId, [runId]), NONE);
});

test("a kept answer whose removal failed to save is removed by the next DELETE: after a restart its Idempotency-Key starts a new run, never the deleted one again", { timeout: 180_000 }, async (t) => {
  const first = await serve(t);
  const made = await first.api("POST", "/runs", inline("What is six times seven?"), { "idempotency-key": "kept-once" });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  await follow(first.api, made.body.run_id, ["completed"]);
  const agentId = made.body.agent_id;

  // The kept answers' file cannot be written once: the save of the cleaned answers fails, and the DELETE stops.
  const blocker = join(first.data, ".idempotency.json.partial");
  await mkdir(blocker);
  const stopped = await first.api("DELETE", `/agents/${agentId}`);
  assert.ok(stopped.status >= 500, `the DELETE stops: ${stopped.status} ${JSON.stringify(stopped.body)}`);
  assert.equal((await first.api("GET", `/agents/${agentId}`)).status, 200, "the agent is kept");
  await rm(blocker, { recursive: true });

  const done = await first.api("DELETE", `/agents/${agentId}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  await first.stop();

  const { api } = await serve(t, { data: first.data });
  const again = await api("POST", "/runs", inline("What is six times seven?"), { "idempotency-key": "kept-once" });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal(again.headers.get("idempotent-replayed"), null, "not a replay of the deleted run's answer");
  assert.notEqual(again.body.run_id, made.body.run_id, "a new run");
  assert.notEqual(again.body.agent_id, agentId, "of a new agent");
  await follow(api, again.body.run_id, ["completed"]);
});

test("an agent being deleted takes no write to its home or its learning: 409 agent_not_runnable; one sent while a DELETE runs waits for it and finds the agent gone, nothing of it left", { timeout: 180_000 }, async (t) => {
  const learning = fakeLearning();
  learning.busy = true;
  const gate = { armed: false };
  const { api, data } = await serve(t, {
    deleteLearning: learning.deleteLearning,
    agentDeleteAt: async (at) => {
      if (at !== "in_step_3" || !gate.armed) return;
      gate.armed = false;
      gate.reached();
      await gate.held;
    },
  });
  const { agentId } = await finishedAgent(api);
  assert.equal((await api("DELETE", `/agents/${agentId}`)).status, 409, "marked, and kept there by its learning's refusal");

  // A home file's route, its parts joined (as home.test.mjs builds it).
  const homeFile = (name) => ["/agents", agentId, "home", "files", name].join("/");
  refusedDeleting(await api("PUT", homeFile("notes.md"), "kept notes"), "a home file");
  refusedDeleting(await api("PUT", `/agents/${agentId}/learning/corrections`, { text: "- Answer in tables.\n" }), "a corrections write");
  assert.equal((await api("GET", `/agents/${agentId}/home/files`)).body.files?.length ?? 0, 0, "nothing written to its home");

  // A write sent while the DELETE is in step 3: it waits for the DELETE, then finds no agent.
  learning.busy = false;
  gate.armed = true;
  const reached = new Promise((resolve) => (gate.reached = resolve));
  gate.held = new Promise((resolve) => (gate.release = resolve));
  const deleting = api("DELETE", `/agents/${agentId}`);
  await reached;
  const writing = api("PUT", homeFile("late.md"), "late notes");
  await new Promise((resolve) => setTimeout(resolve, 500));
  gate.release();
  const [deleted, written] = await Promise.all([deleting, writing]);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.deepEqual([written.status, written.body.error?.code], [404, "not_found"], JSON.stringify(written.body));
  assert.ok(!existsSync(join(data, "disk", "agents", agentDir(agentId))), "nothing of the agent is left on the disk");
});

/** `promise`, or a failure in words once `ms` have passed: a hold a test waits for that never comes fails the test then. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms).unref())]);

test("a run's grade and a home file's delete sent once the agent's learning is deleted wait for the DELETE and find the agent gone: no grade or audit row is written back", { timeout: 180_000 }, async (t) => {
  const gate = { armed: false };
  const { api, data, store } = await serve(t, {
    agentDeleteAt: async (at) => {
      if (at !== "after_step_2" || !gate.armed) return;
      gate.armed = false;
      gate.reached();
      await gate.held;
    },
  });
  const { agentId, runId } = await finishedAgent(api);
  const homeFile = (name) => ["/agents", agentId, "home", "files", name].join("/");
  assert.equal((await api("PUT", homeFile("notes.md"), "kept notes")).status, 200);

  // The DELETE held after step 2: its learning is gone, its runs and folders are not yet.
  gate.armed = true;
  const reached = new Promise((resolve) => (gate.reached = resolve));
  gate.held = new Promise((resolve) => (gate.release = resolve));
  const deleting = api("DELETE", `/agents/${agentId}`);
  await within(reached, 60_000, "the DELETE reached the end of step 2");
  const grading = api("PUT", `/runs/${runId}/grade`, { correct: true });
  const removing = api("DELETE", homeFile("notes.md"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  gate.release();
  const [deleted, graded, removed] = await Promise.all([deleting, grading, removing]);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.deepEqual([graded.status, graded.body.error?.code], [404, "not_found"], `the grade: ${JSON.stringify(graded.body)}`);
  assert.deepEqual([removed.status, removed.body.error?.code], [404, "not_found"], `the home file's delete: ${JSON.stringify(removed.body)}`);
  assert.deepEqual(await recordsOf(store, agentId), [], "no grade record of the deleted agent");
  assert.ok(!existsSync(join(data, "disk", "agents", agentDir(agentId))), "nothing of the agent is left on the disk, no audit row");
});

test("an inline run's answer still being made when a DELETE forgets its run is not kept: its Idempotency-Key starts a new run, never the deleted one, after a restart too", { timeout: 180_000 }, async (t) => {
  const hold = { armed: true };
  const reached = new Promise((resolve) => (hold.reached = resolve));
  hold.held = new Promise((resolve) => (hold.release = resolve));
  const first = await serve(t, {
    beforeKeep: async (path, answer) => {
      if (path !== "/runs" || !hold.armed) return;
      hold.armed = false;
      hold.reached(answer);
      await hold.held;
    },
  });
  // The run is made and its answer built; the request is held before its answer is kept, while the DELETE runs.
  const posting = first.api("POST", "/runs", inline("What is six times seven?"), { "idempotency-key": "in-flight" });
  const answer = await within(reached, 60_000, "the POST reached its answer's keep");
  await follow(first.api, answer.run_id, ["completed"]);
  const deleted = await first.api("DELETE", `/agents/${answer.agent_id}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  hold.release();
  const made = await posting;
  assert.equal(made.status, 202, JSON.stringify(made.body));
  assert.equal(made.body.run_id, answer.run_id, "the request's own answer, given all the same");

  const again = await first.api("POST", "/runs", inline("What is six times seven?"), { "idempotency-key": "in-flight" });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal(again.headers.get("idempotent-replayed"), null, "not a replay of the deleted run's answer");
  assert.notEqual(again.body.run_id, answer.run_id, "a new run");
  assert.notEqual(again.body.agent_id, answer.agent_id, "of a new agent");
  await follow(first.api, again.body.run_id, ["completed"]);
  await first.stop();

  // After a restart the key replays the new run, the one it kept, never the deleted one.
  const { api } = await serve(t, { data: first.data });
  const later = await api("POST", "/runs", inline("What is six times seven?"), { "idempotency-key": "in-flight" });
  assert.equal(later.status, 202, JSON.stringify(later.body));
  assert.equal(later.headers.get("idempotent-replayed"), "true");
  assert.equal(later.body.run_id, again.body.run_id, "the new run, kept under the key");
});
