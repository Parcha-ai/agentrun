// The trigger target policy (trigger-targets.ts) over a real one store (A): what a trigger may start or message, and the
// words each refusal answers with, rewritten over the run write half and the run readers. The run view (a run's moment, its
// status) and the agent reads are passed in; these tests build them directly, as the switch wires the real ones.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");
const { triggerTargets } = await import("../dist/trigger-targets.js");
const { readLaunchBody } = await import("../dist/run-launch.js");

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshStore() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tt-"));
  dirs.push(dir);
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  after(() => store.close().catch(() => undefined));
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: { instructions: "Answer." } });
  return store;
}

const revisionOf = (over = {}) => ({ id: "r1", agentId: "a1", kind: "agentic", body: { instructions: "Answer.", tools: [], skills: {}, ...over }, createdAt: 0 });
const entryOf = (over = {}) => ({ agent: { id: "a1", name: "Agent one", description: null, currentRevision: "r1", createdAt: 0, archivedAt: null }, revision: revisionOf(), version: 1, revisions: 1, sizes: new Map(), ...over });

const startDeps = (over = {}) => ({
  runBodyIssues: () => [],
  pinnedOf: async () => ({ revision: revisionOf(), version: 1 }),
  inputIssuesOf: async () => [],
  explainRun: async (issues) => issues,
  told: (error) => error,
  runnable: async () => {},
  readyFiles: async () => [],
  fallbackPlace: () => ({ mode: "runner" }),
  workflowTitle: (name) => `Workflow of ${name}`,
  serverSecrets: () => [],
  toolSettings: () => ({}),
  planeEnv: () => ({}),
  modelOf: () => ({ provider: "anthropic", modelId: "claude" }),
  ...over,
});

const moment = (over = {}) => ({
  id: "run-1", agentId: "a1", kind: "agentic", cancelled: false, terminal: false, working: true,
  awaitingAnswer: false, steers: true, live: true, paused: false, waitsOnPerson: false, maxCostUsd: 5, ...over,
});

const deps = (over = {}) => {
  const { start: startOver, ...rest } = over;
  return {
    start: startDeps(startOver),
    getAgent: async () => entryOf(),
    needAgent: async () => entryOf(),
    momentOf: async () => moment(),
    runStatus: async () => "working",
    ...rest,
  };
};

const from = { kind: "trigger", trigger_id: "t1", source: "schedule", owner: true };
/** A message_run trigger t1 to run-1, holding firings `keys` due: what a trigger's message is queued under. */
async function dueFirings(store, keys = ["f1"]) {
  await store.triggers.create({ id: "t1", agentId: "a1", name: "poke", enabled: true, source: { kind: "schedule" }, target: { kind: "message_run", run_id: "run-1", input: { content: "hi" } }, nextAt: null, catchupWindowS: 3600 });
  await store.triggers.record("t1", keys.map((key) => ({ key, by: "schedule", nominalAt: 0, status: "due" })));
}
const BOUND = { max: 1, reason: "A message from this trigger is already waiting." };

// ---- targetIssues ---------------------------------------------------------------------------------------------------

test("a message_run target with a cap is allowed", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps());
  assert.deepEqual(await t.targetIssues({ kind: "message_run", run_id: "run-1", input: { content: "hi" } }), []);
});

test("a message_run target to an unknown run is not_found", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ momentOf: async () => undefined }));
  const issues = await t.targetIssues({ kind: "message_run", run_id: "run-x", input: { content: "hi" } });
  assert.equal(issues[0].reason, "not_found");
});

test("a message_run target to a run with no cap is refused with the cap words", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ momentOf: async () => moment({ maxCostUsd: undefined }) }));
  const issues = await t.targetIssues({ kind: "message_run", run_id: "run-1", input: { content: "hi" } });
  assert.equal(issues[0].reason, "not_allowed");
  assert.match(issues[0].message, /only messages a run with one/);
});

test("a message_run target to a workflow run is not_allowed", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ momentOf: async () => moment({ kind: "workflow" }) }));
  const issues = await t.targetIssues({ kind: "message_run", run_id: "run-1", input: { content: "hi" } });
  assert.match(issues[0].message, /A workflow run takes no messages here\./);
});

test("a start_run target for an unknown agent is not_found", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ getAgent: async () => undefined }));
  const issues = await t.targetIssues({ kind: "start_run", agent_id: "aX", input: { content: "hi" }, max_cost_usd: 1 });
  assert.equal(issues[0].reason, "not_found");
});

test("a start_run target for an agent with no current revision is invalid", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ getAgent: async () => entryOf({ revision: null }) }));
  const issues = await t.targetIssues({ kind: "start_run", agent_id: "a1", input: { content: "hi" }, max_cost_usd: 1 });
  assert.match(issues[0].message, /has no current revision/);
});

test("a start_run target with no cap and no agent default is refused (every trigger run is capped)", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps());
  const issues = await t.targetIssues({ kind: "start_run", agent_id: "a1", input: { content: "hi" } });
  assert.equal(issues[0].field, "target.max_cost_usd");
  assert.match(issues[0].message, /Every run a trigger starts is capped/);
});

test("a start_run target with the agent's default cap is allowed", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ start: { pinnedOf: async () => ({ revision: revisionOf({ maxCostUsd: 2 }), version: 1 }) } }));
  assert.deepEqual(await t.targetIssues({ kind: "start_run", agent_id: "a1", input: { content: "hi" } }), []);
});

// ---- start / message / statusOf / runOf -----------------------------------------------------------------------------

test("start inserts a queued, capped run under the firing's key", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps());
  const { run_id } = await t.start({ kind: "start_run", agent_id: "a1", input: { content: "hi" }, max_cost_usd: 3 }, { content: "hi" }, { id: "t1", firing_key: "f1" }, from);
  const row = await store.runs.get(run_id);
  assert.equal(row.state, "queued");
  assert.equal(readLaunchBody((await store.runs.launch(run_id)).body).maxCostUsd, 3);
  // The firing's key found the run: a retry gets the same one.
  assert.equal((await store.runOfOrigin("f1")).runId, run_id);
});

test("message to a working run writes a steer that answers no person, its firing marked sent in the same write; past the trigger's bound for the run a firing is skipped in words, nothing written", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  await dueFirings(store, ["f1", "f2"]);
  const t = triggerTargets(store, deps());
  const target = { kind: "message_run", run_id: "run-1", input: { content: "from the schedule" } };
  assert.equal(await t.message(target, { content: "from the schedule" }, "f1", from, BOUND), undefined);
  const rows = await store.commands("run-1", 0);
  assert.deepEqual(rows.map((row) => [row.kind, row.body.text, row.body.answers, row.body.origin]), [["steer", "from the schedule", false, from]]);
  assert.deepEqual([(await store.triggers.firing("t1", "f1")).status, (await store.triggers.firing("t1", "f1")).runId], ["sent", "run-1"], "sent with its row, in one transaction");
  assert.deepEqual(await t.message(target, { content: "from the schedule" }, "f2", from, BOUND), { skipped: BOUND.reason });
  assert.equal((await store.commands("run-1", 0)).length, 1, "the second waits for nothing: skipped");
  assert.equal((await store.triggers.firing("t1", "f2")).status, "skipped");
});

test("message to a run waiting on a person is skipped, nothing written", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const t = triggerTargets(store, deps({ momentOf: async () => moment({ waitsOnPerson: true }) }));
  const answer = await t.message({ kind: "message_run", run_id: "run-1", input: { content: "hi" } }, { content: "hi" }, "f1", from, BOUND);
  assert.deepEqual(answer, { skipped: "The run is waiting on a person." });
  assert.equal((await store.commands("run-1", 0)).length, 0);
});

test("message to a run with no cap is refused with the cap words", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const t = triggerTargets(store, deps({ momentOf: async () => moment({ maxCostUsd: undefined }) }));
  await assert.rejects(
    () => t.message({ kind: "message_run", run_id: "run-1", input: { content: "hi" } }, { content: "hi" }, "f1", from, BOUND),
    (e) => e.code === "not_continuable" && /only messages a run with one/.test(e.message),
  );
});

test("runOf finds a run started under a key: a run is inserted whole, so a found run started", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1", origin: { key: "f1" } });
  const t = triggerTargets(store, deps());
  assert.deepEqual(await t.runOf("f1"), { run_id: "run-1" });
  assert.equal(await t.runOf("nope"), null);
});
