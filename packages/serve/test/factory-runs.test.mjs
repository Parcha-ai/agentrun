import assert from "node:assert/strict";
import { test } from "node:test";
import { factoryRunsPage } from "../dist/factory-runs.js";
import { summaryOverStore } from "../dist/store-view.js";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { serve } from "./support.mjs";
import { schemaProblems } from "./schema-support.mjs";

const url = (query = "scope=active") => new URL(`https://run.test/v2/runs?${query}`);
const brief = async (id) => ({ run_id: id });
const launch = { body: { input: { content: "Work." }, title: "Work", place: { mode: "runner" } } };
async function make(store, id, { state, outcome, agent = "agent-1", revision = "rev-1" } = {}) {
  await store.runs.create({ id, agentId: agent, revisionId: revision }, launch);
  if (!state || state === "queued") return;
  const claim = await store.claim(id, "runner-test", { leaseMs: 60_000 });
  if (state === "running") return;
  if (state === "parked") return store.release(claim, { state: "parked" });
  await store.runs.update(claim, { state, outcome, endedAt: T0 + 1000 });
}

test("factory active selects old work before limiting history; continuable, parked and archived executions stay visible", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  await store.agents.create({ id: "workflow", name: "Workflow" }, { id: "workflow-rev", kind: "workflow", body: { workflow: {} } });
  for (const [id, state, outcome] of [["old-queued", "queued"], ["old-running", "running"], ["old-parked", "parked"], ["old-stopped", "stopped", "stopped"], ["old-archived", "queued"]]) await make(store, id, { state, outcome });
  await store.runs.archive("old-archived", true);
  clock.now += 10_000;
  for (let n = 0; n < 125; n++) await make(store, `history-${n}`, { state: "ended", outcome: "completed" });
  await make(store, "cancelled", { state: "stopped", outcome: "cancelled" });
  await make(store, "workflow-stopped", { state: "stopped", outcome: "stopped", agent: "workflow", revision: "workflow-rev" });
  await make(store, "review", { state: "ended", outcome: "escalated" });
  await make(store, "failed", { state: "failed" });
  await make(store, "archived-review", { state: "ended", outcome: "escalated" });
  await store.runs.archive("archived-review", true);
  await make(store, "archived-failed", { state: "failed" });
  await store.runs.archive("archived-failed", true);
  await store.importRun({ id: "imported-review", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "codex", session: "imported" }, launch, outcome: "escalated", costUsd: null, summary: null, startedAt: clock.now, endedAt: clock.now, transcript: [] });
  const opened = [];
  const page = await factoryRunsPage(store, url(), {}, async id => { opened.push(id); return brief(id); }, () => clock.now);
  assert.deepEqual(opened.sort(), ["old-archived", "old-parked", "old-queued", "old-running", "old-stopped"]);
  assert.equal(page.next_cursor, null);
  assert.equal(page.scope, "active");
  assert.equal(page.observed_at, new Date(clock.now).toISOString());
  assert.deepEqual((await factoryRunsPage(store, url("scope=review"), {}, brief)).runs.map(r => r.run_id).sort(), ["failed", "review"]);
  await store.agents.archive("agent-1", true);
  assert.equal((await factoryRunsPage(store, url(), {}, brief)).runs.length, 5, "an archived agent can still have active work");
  assert.deepEqual((await factoryRunsPage(store, url("scope=review"), {}, brief)).runs, [], "archived terminal history is acknowledged");
});

test("factory keysets survive changing membership and tie timestamps, with bounded per-page reads", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  for (const id of ["run-a", "run-b", "run-c", "run-d"]) await make(store, id);
  const opened = [];
  const first = await factoryRunsPage(store, url("scope=active&limit=2"), { agent: "agent-1" }, async id => { opened.push(id); return brief(id); });
  assert.deepEqual(opened, ["run-d", "run-c"]);
  assert.ok(first.next_cursor);
  const claim = await store.claim("run-d", "finisher", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended", outcome: "completed", endedAt: clock.now });
  clock.now += 1000;
  await make(store, "run-new");
  const next = await factoryRunsPage(store, url(`scope=active&limit=2&cursor=${first.next_cursor}`), { agent: "agent-1" }, brief);
  assert.deepEqual(next.runs.map(r => r.run_id), ["run-b", "run-a"]);
  assert.equal(next.next_cursor, null);
  for (const [query, filter] of [["scope=review", { agent: "agent-1" }], ["scope=active", {}], ["scope=active", { agent: "agent-1", revision: "rev-1" }]]) {
    await assert.rejects(factoryRunsPage(store, url(`${query}&cursor=${first.next_cursor}`), filter, brief), { code: "bad_request" });
  }
});

test("factory rejects malformed cursors and filters before querying", async () => {
  const store = { runs: { list: () => { throw new Error("must not read"); } } };
  for (const query of ["scope=unknown", "scope=active&status=working", "scope=active&archived=false", "scope=active&limit=0", "scope=active&limit=101", "scope=active&limit=1.5", "scope=active&cursor=0", `scope=active&cursor=factory.${Buffer.from(JSON.stringify({ version: 1, scope: "active", before: { startedAt: 1, id: "bad/id" } })).toString("base64url")}`]) {
    await assert.rejects(factoryRunsPage(store, url(query), {}, brief), { code: "bad_request" }, query);
  }
  await assert.rejects(factoryRunsPage(store, url(), { revision: "bad/id" }, brief), { code: "bad_request" });
});

test("active factory includes independently stored internal workers while ordinary history and terminal review keep their boundary", async t => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await make(store, "parent");
  const claim = await store.claim("parent", "runner-test", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended", outcome: "completed" }, { also: [
    { table: "learning_proposals", row: { turn: { prompt: "Learn", answer: "Learned" }, proposal: { notes: [] } } },
    { table: "learning_run", row: { id: "learning-worker" } },
  ] });
  assert.deepEqual((await factoryRunsPage(store, url(), {}, brief)).runs.map(r => r.run_id), ["learning-worker"]);
  const summary = await summaryOverStore(store, "learning-worker", { origin: "https://run.test", serverSecrets: () => [], factory: true });
  assert.equal(summary.factory.runtime, "learning");
  assert.equal(summary.factory.control, "managed");
  assert.equal(summary.factory.controls.cancel, true);
  assert.deepEqual((await store.runs.list({})).map(r => r.id), ["parent"]);
  const worker = await store.claim("learning-worker", "runner-test", { leaseMs: 60_000 });
  await store.runs.update(worker, { state: "failed" });
  assert.deepEqual((await factoryRunsPage(store, url("scope=review"), {}, brief)).runs, []);
});

test("HTTP factory scope carries metadata and cursor; ordinary history keeps its prior response", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Work.", computer: { kind: "sandbox", provider: "docker" } } });
  await make(store, "run-a");
  await make(store, "run-b");
  const scoped = await api("GET", "/runs?scope=active&limit=1");
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.scope, "active");
  assert.ok(scoped.body.observed_at);
  assert.ok(scoped.body.next_cursor);
  assert.equal(scoped.body.runs[0].factory.source, "managed");
  assert.equal(scoped.body.runs[0].computer.state, "starting");
  assert.equal(scoped.body.runs[0].computer.kind, "sandbox");
  const document = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(document, { $ref: "#/components/schemas/RunList" }, scoped.body), []);
  const agent = await api("GET", `/agents/agent-1/runs?scope=active&limit=1`);
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal(agent.body.runs[0].run_id, "run-b");
  const history = await api("GET", "/runs?limit=1");
  assert.equal(history.status, 200);
  assert.equal("scope" in history.body, false);
  assert.equal("factory" in history.body.runs[0], false);
  assert.equal("computer" in history.body.runs[0], false);
  assert.equal((await api("GET", "/runs?scope=active&status=working")).status, 400);
});
