// A request's workspace (workspace-scope.ts): an API-only server's backend names it in the AgentRun-Workspace header,
// with a server token, and the request then reaches that workspace's agents, runs and imported template packages alone.
// Another workspace's row answers the same 404 as a missing one, every list holds the workspace's rows alone, what it
// makes is stamped, and an Idempotency-Key is the workspace's own. A token listed in AGENTRUN_WORKSPACE_TOKENS must send
// the header; the header is refused off an API-only server and from any credential but a server token; a scoped request
// is served only the operations of WORKSPACE_ROUTES. A run made unscoped reads as its agent's workspace's. A request with
// no header is served as before.
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { atTestEnd, client, dropSchema, freshSchema, onPostgres, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";
import { storeOn } from "./store-helpers.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { answerFlow, scratch, serve, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { fakeClock, until } from "./trigger-support.mjs";

const { WORKSPACE_ROUTES, servedScoped } = await import("../dist/api-only.js");
const { ROUTES } = await import("../dist/server.js");
const { migrate, openPostgresStore, openSqliteStore, migrationsIn, runnerOn, StoreAwaitsServer } = await import("../dist/store/index.js");
const { SCHEMA_VERSION } = await import("../dist/store/schema.js");
const { workspaceTokensFrom } = await import("../dist/workspace-scope.js");
/** An agent's home files route (`/agents/{id}/home/files`); a file in it is this plus `/<name>`. */
const homeFiles = (agent) => `/v2/agents/${agent}/home/files`;
const { backfillMapOf, backfillWorkspaces, workspaceBackfillMain } = await import("../dist/workspace-backfill.js");
const { deleteTemplate, importTemplate, templateNames } = await import("../dist/template-import.js");
const { TemplateRegistry } = await import("../dist/templates.js");
const { inWorkspace, outsideWorkspace, workspaceNow } = await import("../dist/workspace-scope.js");
const { Triggers } = await import("../dist/triggers.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { agentHomeFolder } = await import("../dist/workspace/index.js");
const { scopedPairedWords } = await import("../dist/workspace/attached-computers.js");
const { PROTOCOL_VERSION } = await import("@parcha/agentrun-computer");

const SCOPED = randomBytes(24).toString("hex");
const OPERATOR = randomBytes(24).toString("hex");
const W1 = "org:acme.one_1";
const W2 = "org:other-2";

const PACKAGE = `---
name: deployed
version: 1.0.0
description: Answers a question.
tools: []
---
Answer the question.
`;
const UPLOADED = PACKAGE.replace("name: deployed", "name: notes");

/** An API-only server with the bundled `deployed` package, no runner, and two tokens: `v2` (in
 *  AGENTRUN_WORKSPACE_TOKENS, scoped) and `ops` (the operator's, unscoped). `options` over those. */
async function scopedServer(t, options = {}) {
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "deployed"), { recursive: true });
  writeFileSync(join(root, "deployed", "agent.md"), PACKAGE);
  return serve(t, { templates: root, runner: false, apiOnly: true, tokens: [{ id: "v2", token: SCOPED }, { id: "ops", token: OPERATOR }], workspaceTokens: ["v2"], ...options });
}

/** One request: its status, body text, parsed body and headers. `workspace` the header (none when undefined), `token` the
 *  bearer (none when null). */
async function send(server, method, path, { workspace, token = SCOPED, body, headers = {} } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(workspace === undefined ? {} : { "agentrun-workspace": workspace }), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body: json, headers: res.headers };
}
const inW1 = (server, method, path, options = {}) => send(server, method, path, { workspace: W1, ...options });
const inW2 = (server, method, path, options = {}) => send(server, method, path, { workspace: W2, ...options });
const unscoped = (server, method, path, options = {}) => send(server, method, path, { token: OPERATOR, ...options });

/** An answer's text with its request id and `id` in placeholders: two answers that differ only in those are equal. */
const shape = (answer, id) => `${answer.status} ${answer.text.replaceAll(/req_[0-9a-f]{16}/g, "<request>").replaceAll(id, "<id>")}`;

/** An id of the same form as `id` that no row has. */
const missingLike = (id) => `${id.slice(0, -6)}ffffff`;

/** W1's agent (made by the scoped createAgent), its run, and W1's imported package. */
async function seedW1(server) {
  const agent = await inW1(server, "POST", "/v2/agents", { body: { definition: { version: 1, name: "W1 agent", instructions: "Answer.", skills: [], tools: [] } } });
  assert.equal(agent.status, 201, agent.text);
  const run = await inW1(server, "POST", `/v2/agents/${agent.body.agent_id}/runs`, { body: { input: { content: "Hello." } } });
  assert.equal(run.status, 202, run.text);
  const imported = await inW1(server, "POST", "/v2/templates/import", { body: { files: [{ path: "agent.md", encoding: "utf8", content: UPLOADED }] } });
  assert.equal(imported.status, 201, imported.text);
  return { agent: agent.body.agent_id, run: run.body.run_id, template: imported.body.template.id };
}

/** A file `request` reserves (POST /v2/files, 5 bytes at `path`): its id. */
async function reserved(request, server, path) {
  const answer = await request(server, "POST", "/v2/files", { body: { path, size_bytes: 5 } });
  assert.equal(answer.status, 201, answer.text);
  assert.equal(answer.body.file.workspace, undefined, "no answer names a workspace");
  return answer.body.file.file_id;
}

/** A file's bytes sent raw, in `workspace` (unscoped, with the operator's token, when undefined): POST /v2/files?path=
 *  (one call, `id` undefined) or PUT /v2/files/{id}. Its status and parsed body. */
async function bytes(server, workspace, { path, id, body = "hello" }) {
  const headers = { authorization: `Bearer ${workspace === undefined ? OPERATOR : SCOPED}`, "content-type": "text/plain", ...(workspace === undefined ? {} : { "agentrun-workspace": workspace }) };
  const res = await fetch(id === undefined ? `${server.url}/v2/files?path=${encodeURIComponent(path)}` : `${server.url}/v2/files/${id}`, { method: id === undefined ? "POST" : "PUT", headers, body });
  return { status: res.status, body: await res.json() };
}

/** Every operation of WORKSPACE_ROUTES: how a scoped request reaches it, and what a row of another workspace reads as.
 *  `row`: the operation names W1's row by id (agent, run or template), and W2 gets the 404 a missing id gets. `list`: W2's
 *  list holds none of W1's rows. `made`: a write W2 makes lands in W2 alone. `served`: answered to any workspace.
 *  `catalog`: Composio's catalog, tested on its own. */
const TABLE = {
  getRun: { method: "GET", path: "/v2/runs/{run}", row: "run" },
  getTimeline: { method: "GET", path: "/v2/runs/{run}/timeline", row: "run" },
  listRunFiles: { method: "GET", path: "/v2/runs/{run}/files", row: "run" },
  readRunFile: { method: "GET", path: "/v2/runs/{run}/files/out/report.md", row: "run" },
  getRunExport: { method: "GET", path: "/v2/runs/{run}/export", row: "run" },
  sendMessage: { method: "POST", path: "/v2/runs/{run}/messages", row: "run", body: { content: "More." } },
  stopRun: { method: "POST", path: "/v2/runs/{run}/stop", row: "run", body: {} },
  cancelRun: { method: "POST", path: "/v2/runs/{run}/cancel", row: "run", body: {} },
  deleteRun: { method: "DELETE", path: "/v2/runs/{run}", row: "run" },
  raiseRunCap: { method: "PATCH", path: "/v2/runs/{run}", row: "run", body: { max_cost_usd: 5 } },
  getRunGraph: { method: "GET", path: "/v2/runs/{run}/graph", row: "run" },
  getRunTrace: { method: "GET", path: "/v2/runs/{run}/trace", row: "run" },
  pauseRun: { method: "POST", path: "/v2/runs/{run}/pause", row: "run", body: {} },
  resumeRun: { method: "POST", path: "/v2/runs/{run}/resume", row: "run", body: {} },
  archiveRun: { method: "POST", path: "/v2/runs/{run}/archive", row: "run", body: {} },
  unarchiveRun: { method: "POST", path: "/v2/runs/{run}/unarchive", row: "run", body: {} },
  gradeRun: { method: "PUT", path: "/v2/runs/{run}/grade", row: "run", body: { correct: true } },
  startRun: { method: "POST", path: "/v2/runs/{run}/start", row: "run", body: {} },
  getAgent: { method: "GET", path: "/v2/agents/{agent}", row: "agent" },
  listRevisions: { method: "GET", path: "/v2/agents/{agent}/revisions", row: "agent" },
  listRuns: { method: "GET", path: "/v2/agents/{agent}/runs", row: "agent" },
  createRun: { method: "POST", path: "/v2/agents/{agent}/runs", row: "agent", body: { input: { content: "Hello." } } },
  updateDefinition: { method: "PUT", path: "/v2/agents/{agent}/definition", row: "agent", body: { definition: { version: 1, name: "W2 edit", instructions: "Answer.", skills: [], tools: [] } } },
  setCurrent: { method: "POST", path: "/v2/agents/{agent}/current", row: "agent", body: { revision_id: "rev_none" } },
  getAgentPackage: { method: "GET", path: "/v2/agents/{agent}/package", row: "agent" },
  getRevisionSkills: { method: "GET", path: "/v2/agents/{agent}/revisions/rev_none/skills", row: "agent" },
  listHomeFiles: { method: "GET", path: "/v2/agents/{agent}/home/files", row: "agent" },
  readHomeFile: { method: "GET", path: "/v2/agents/{agent}/home/files/notes.md", row: "agent" },
  deleteHomeFile: { method: "DELETE", path: "/v2/agents/{agent}/home/files/notes.md", row: "agent" },
  archiveAgent: { method: "POST", path: "/v2/agents/{agent}/archive", row: "agent" },
  unarchiveAgent: { method: "POST", path: "/v2/agents/{agent}/unarchive", row: "agent" },
  deleteAgent: { method: "DELETE", path: "/v2/agents/{agent}", row: "agent" },
  getTemplate: { method: "GET", path: "/v2/templates/{template}", row: "template" },
  applyTemplate: { method: "POST", path: "/v2/templates/{template}/apply", row: "template", body: { parameters: {} } },
  deleteTemplate: { method: "DELETE", path: "/v2/templates/{template}", row: "template" },
  getFile: { method: "GET", path: "/v2/files/{file}", row: "file" },
  uploadFile: { method: "PUT", path: "/v2/files/{file}", row: "file", body: "hello" },
  deleteFile: { method: "DELETE", path: "/v2/files/{file}", row: "file" },
  listAllRuns: { method: "GET", path: "/v2/runs", list: (body) => body.runs.map((one) => one.id ?? one.run_id) , of: "run" },
  listAgents: { method: "GET", path: "/v2/agents", list: (body) => body.agents.map((one) => one.agent_id), of: "agent" },
  listTemplates: { method: "GET", path: "/v2/templates", list: (body) => body.templates.map((one) => one.id), of: "template" },
  listFiles: { method: "GET", path: "/v2/files", list: (body) => body.files.map((one) => one.file_id), of: "file" },
  createAgent: { made: true },
  importTemplate: { made: true },
  createFile: { made: true },
  // A trigger is its agent's: api-only-workspace-triggers.test.mjs (it needs the launch hook to make one).
  listTriggers: { triggers: true },
  getTrigger: { triggers: true },
  listTriggerFirings: { triggers: true },
  createTrigger: { triggers: true },
  updateTrigger: { triggers: true },
  deleteTrigger: { triggers: true },
  fireTrigger: { triggers: true },
  getCapabilities: { method: "GET", path: "/v2/capabilities", served: true },
  getHealth: { method: "GET", path: "/v2/health", served: true },
  getOpenapi: { method: "GET", path: "/v2/openapi.json", served: true },
  validateWorkflow: { method: "POST", path: "/v2/workflows/validate", served: true, body: { workflow: { v: 2, name: "nothing" } } },
  // Composio's catalog, no workspace's row: api-only-composio-listing.test.mjs.
  listComposioToolkits: { catalog: true },
  listComposioTools: { catalog: true },
};

test("every operation of WORKSPACE_ROUTES is a route of the server, and the table below covers each", () => {
  const names = new Set(ROUTES.map((route) => route.name));
  for (const name of WORKSPACE_ROUTES) assert.ok(names.has(name), `${name} is in ROUTES`);
  assert.deepEqual([...WORKSPACE_ROUTES].sort(), Object.keys(TABLE).sort());
  assert.equal(servedScoped(ROUTES, "GET", "/v2/runs/r1"), "served");
  assert.equal(servedScoped(ROUTES, "HEAD", "/v2/agents/a1"), "served");
  assert.equal(servedScoped(ROUTES, "DELETE", "/v2/agents/a1"), "served");
  assert.equal(servedScoped(ROUTES, "DELETE", "/v2/agents/a1/learning"), "not_scoped");
  assert.equal(servedScoped(ROUTES, "GET", "/v2/usage"), "not_scoped");
  assert.equal(servedScoped(ROUTES, "GET", "/v2/runs/r1/computer/live/v/x"), "not_scoped");
  assert.equal(servedScoped(ROUTES, "GET", "/v2/nothing-here"), "none");
  assert.equal(servedScoped(ROUTES, "GET", "/"), "none");
});

test("a scoped request reads another workspace's row as a missing one, the same 404 to the byte, its lists hold its own rows alone, and its writes are its own", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const w1 = { ...(await seedW1(server)), file: await reserved(inW1, server, "notes.md") };
  for (const [name, op] of Object.entries(TABLE)) {
    if (op.row) {
      const id = w1[op.row];
      const path = op.path.replace(`{${op.row}}`, encodeURIComponent(id));
      const theirs = await inW2(server, op.method, path, op.body === undefined ? {} : { body: op.body });
      const missing = await inW2(server, op.method, op.path.replace(`{${op.row}}`, encodeURIComponent(missingLike(id))), op.body === undefined ? {} : { body: op.body });
      assert.equal(theirs.status, 404, `${name}: ${theirs.text}`);
      assert.equal(shape(theirs, id), shape(missing, missingLike(id)), `${name}: W1's ${op.row} reads as a missing one`);
      const own = { run: `/v2/runs/${id}`, agent: `/v2/agents/${id}`, template: `/v2/templates/${encodeURIComponent(id)}`, file: `/v2/files/${id}` }[op.row];
      assert.equal((await inW1(server, "GET", own)).status, 200, `${name}: W1 reads its own ${op.row}`);
    } else if (op.list) {
      const mine = await inW1(server, op.method, op.path);
      const theirs = await inW2(server, op.method, op.path);
      assert.equal(theirs.status, 200, `${name}: ${theirs.text}`);
      assert.ok(op.list(mine.body).includes(w1[op.of]), `${name}: W1's list holds its ${op.of}`);
      assert.ok(!op.list(theirs.body).includes(w1[op.of]), `${name}: W2's list holds none of W1's`);
    } else if (op.served) {
      const answer = await inW2(server, op.method, op.path, op.body === undefined ? {} : { body: op.body });
      assert.equal(answer.status, 200, `${name}: ${answer.text}`);
    }
  }
  // listTemplates still shows W2 the bundled package; a W2 import of the name W1 holds is refused, never replacing it.
  assert.ok(TABLE.listTemplates.list((await inW2(server, "GET", "/v2/templates")).body).includes("deployed"), "the bundled package is every workspace's");
  const taken = await inW2(server, "POST", "/v2/templates/import", { body: { files: [{ path: "agent.md", encoding: "utf8", content: UPLOADED }] } });
  assert.deepEqual([taken.status, taken.body.error?.code], [409, "name_taken"], taken.text);
  assert.equal((await inW1(server, "GET", `/v2/templates/${encodeURIComponent(w1.template)}`)).status, 200, "W1's package stands");
  // createAgent and applyTemplate stamp W2: W2 lists the agents it made, W1 none of them.
  const made = await inW2(server, "POST", "/v2/agents", { body: { definition: { version: 1, name: "W2 agent", instructions: "Answer.", skills: [], tools: [] } } });
  assert.equal(made.status, 201, made.text);
  const applied = await inW2(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: {} } });
  assert.equal(applied.status, 201, applied.text);
  const w2Agents = TABLE.listAgents.list((await inW2(server, "GET", "/v2/agents")).body);
  assert.deepEqual(new Set(w2Agents), new Set([made.body.agent_id, applied.body.agent_id]));
  assert.ok(!TABLE.listAgents.list((await inW1(server, "GET", "/v2/agents")).body).includes(made.body.agent_id));
  // A run a W2 agent makes lists in W2 alone.
  const run = await inW2(server, "POST", `/v2/agents/${made.body.agent_id}/runs`, { body: { input: { content: "Hello." } } });
  assert.equal(run.status, 202, run.text);
  assert.ok(TABLE.listAllRuns.list((await inW2(server, "GET", "/v2/runs")).body).includes(run.body.run_id));
  assert.ok(!TABLE.listAllRuns.list((await inW1(server, "GET", "/v2/runs")).body).includes(run.body.run_id));
  // The operator's unscoped token reads every row, as before.
  assert.equal((await unscoped(server, "GET", `/v2/runs/${w1.run}`)).status, 200);
  assert.equal((await unscoped(server, "GET", `/v2/runs/${run.body.run_id}`)).status, 200);
});

test("a scoped request acts on its own run with the run extras, and a run it purged reads to another workspace as a missing one", { timeout: 120_000 }, async (t) => {
  // A runner beside the server, so W1's run ends and may be graded and purged.
  const server = await scopedServer(t, { runner: true });
  const { agent, run } = await seedW1(server);
  // W1's run with a cap, so a raise reaches the ended run's own refusal (a run with none is refused for having none).
  const capped = await inW1(server, "POST", `/v2/agents/${agent}/runs`, { body: { input: { content: "Hello." }, max_cost_usd: 1 } });
  assert.equal(capped.status, 202, capped.text);
  for (const id of [run, capped.body.run_id]) await until(async () => (await inW1(server, "GET", `/v2/runs/${id}`)).body?.status === "completed", 60_000, "W1's run completes");
  // Each extra's own answer on W1's ended agentic run, as its handler gives it: a refusal is the run's (its words name why
  // this run is refused), never the 404 of a run W1 cannot see, and never a 500.
  const on = (name, id) => inW1(server, TABLE[name].method, TABLE[name].path.replace("{run}", id), TABLE[name].body === undefined ? {} : { body: TABLE[name].body });
  const raised = await on("raiseRunCap", capped.body.run_id);
  assert.deepEqual([raised.status, raised.body.error?.code], [409, "not_continuable"], raised.text);
  assert.match(raised.body.error.message, /^This run is finished\./);
  const graph = await on("getRunGraph", run);
  assert.deepEqual([graph.status, graph.body.error?.code], [404, "not_found"], graph.text);
  assert.match(graph.body.error.message, /is an agentic run; only a workflow run has a graph/);
  const trace = await on("getRunTrace", run);
  assert.equal(trace.status, 200, trace.text);
  assert.equal(trace.body.run_id, run);
  assert.ok(trace.body.spans.length > 0 && trace.body.spans.every((span) => typeof span.id === "string" && typeof span.kind === "string"), trace.text);
  for (const name of ["pauseRun", "resumeRun"]) {
    const refused = await on(name, run);
    assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.capability], [501, "unsupported_here", "runs.pause"], `${name}: ${refused.text}`);
  }
  const graded = await on("gradeRun", run);
  assert.equal(graded.status, 200, graded.text);
  assert.deepEqual([graded.body.run_id, graded.body.correct], [run, true]);
  const notHeld = await on("startRun", run);
  assert.deepEqual([notHeld.status, notHeld.body.error?.code], [404, "not_found"], notHeld.text);
  assert.match(notHeld.body.error.message, /holds no computer: a run started with hold: true holds one/);
  // A live workflow run of W1's: W1 pauses it (its first node held on a file the test makes after the pause, so the
  // second never starts before the pause lands), reads its graph paused, and resumes it to its end.
  const wait = `Answer once ${join(server.data, "w1-paused")} exists.`;
  const twoSteps = answerFlow(wait);
  twoSteps.root.steps.push({ ...twoSteps.root.steps[0], label: "again", instructions: "Answer the question.", as: "again" });
  const flow = await inW1(server, "POST", "/v2/agents", { body: { definition: { name: "W1 flow", workflow: twoSteps } } });
  assert.equal(flow.status, 201, flow.text);
  const live = await inW1(server, "POST", `/v2/agents/${flow.body.agent_id}/runs`, { body: { input: { question: wait } } });
  assert.equal(live.status, 202, live.text);
  const liveId = live.body.run_id;
  await until(async () => (await inW1(server, "GET", `/v2/runs/${liveId}`)).body?.status === "working", 60_000, "W1's workflow is at work");
  const paused = await on("pauseRun", liveId);
  assert.deepEqual([paused.status, paused.body.run_id, paused.body.paused], [200, liveId, true], paused.text);
  writeFileSync(join(server.data, "w1-paused"), "");
  await until(async () => (await inW1(server, "GET", `/v2/runs/${liveId}`)).body?.status === "paused", 30_000, "W1's workflow reads paused");
  const pausedGraph = await on("getRunGraph", liveId);
  assert.equal(pausedGraph.status, 200, pausedGraph.text);
  assert.deepEqual([pausedGraph.body.run.status, Object.keys(pausedGraph.body.nodes).includes("/root/steps/0")], ["paused", true], pausedGraph.text);
  const resumed = await on("resumeRun", liveId);
  assert.deepEqual([resumed.status, resumed.body.run_id, resumed.body.paused], [200, liveId, false], resumed.text);
  await until(async () => (await inW1(server, "GET", `/v2/runs/${liveId}`)).body?.status === "completed", 60_000, "W1's workflow ends once resumed");
  const archived = await inW1(server, "POST", `/v2/runs/${run}/archive`, { body: {} });
  assert.equal(archived.status, 200, archived.text);
  assert.ok(archived.body.archived_at, "the run reads archived");
  const unarchived = await inW1(server, "POST", `/v2/runs/${run}/unarchive`, { body: {} });
  assert.deepEqual([unarchived.status, unarchived.body.archived_at ?? null], [200, null], unarchived.text);
  const purged = await inW1(server, "DELETE", `/v2/runs/${run}`);
  assert.equal(purged.status, 204, purged.text);
  const mine = await inW1(server, "GET", `/v2/runs/${run}`);
  assert.deepEqual([mine.status, mine.body.error?.code], [410, "purged"], mine.text);
  for (const [method, path] of [["GET", "/v2/runs/{run}"], ["DELETE", "/v2/runs/{run}"]]) {
    const theirs = await inW2(server, method, path.replace("{run}", run));
    const missing = await inW2(server, method, path.replace("{run}", missingLike(run)));
    assert.equal(shape(theirs, run), shape(missing, missingLike(run)), `${method}: W1's purged run reads to W2 as a missing one`);
  }
});

test("a scoped request reads its own agent's package, a revision's skills and its home, and removes a home file; the install's saved MCP servers read to it as unsaved ones, and a sign-in's removal stays the owner's", { timeout: 120_000 }, async (t) => {
  const mcp = await startFakeMcp({ token: () => true });
  t.after(() => mcp.close());
  const server = await scopedServer(t, { apiOnlyMcpOrigins: [new URL(mcp.url).origin] });
  // The operator's server: a per_run one at its own origin, saved unscoped, as the install's only MCP server.
  const saved = await unscoped(server, "PUT", "/v2/settings/mcp-servers/opsonly", { body: { url: mcp.url, auth: { type: "per_run", headers: { authorization: "Bearer not-a-secret-list-token" } } } });
  assert.ok(saved.status < 300, saved.text);
  assert.deepEqual((await unscoped(server, "GET", "/v2/settings/mcp-server-names")).body.names, ["opsonly"], "the operator's server is saved");
  const made = await inW1(server, "POST", "/v2/agents", { body: { definition: { version: 1, name: "W1 agent", instructions: "Answer.", skills: [], tools: ["mcp:opsonly/add"] } } });
  assert.equal(made.status, 201, made.text);
  const agent = made.body.agent_id;

  const blockedOf = (answer) => answer.body.report.blocked.find((one) => one.kind === "mcp_server" && one.name === "opsonly");
  const mine = await inW1(server, "GET", `/v2/agents/${agent}/package`);
  assert.equal(mine.status, 200, mine.text);
  assert.match(blockedOf(mine)?.reason ?? "", /not a saved MCP server here/, "in a workspace, the operator's server is one saved nowhere");
  assert.ok(!mine.text.includes(new URL(mcp.url).host), "and nothing of its address reaches the workspace");

  const [revision] = (await inW1(server, "GET", `/v2/agents/${agent}/revisions`)).body.revisions;
  const skills = await inW1(server, "GET", `/v2/agents/${agent}/revisions/${revision.revision}/skills`);
  assert.deepEqual([skills.status, skills.body.skills], [200, {}], skills.text);

  const home = agentHomeFolder(server.data, agent);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "notes.md"), "kept");
  const listed = await inW1(server, "GET", `/v2/agents/${agent}/home/files`);
  assert.deepEqual([listed.status, listed.body.files.map((one) => one.path)], [200, ["notes.md"]], listed.text);
  const read = await inW1(server, "GET", `${homeFiles(agent)}/notes.md`);
  assert.deepEqual([read.status, read.text], [200, "kept"]);
  const owned = await inW1(server, "GET", `${homeFiles(agent)}/learning/notes.md`);
  assert.deepEqual([owned.status, owned.body.error?.code], [403, "system_file_forbidden"], "a host-owned path stays the server's");
  const removed = await inW1(server, "DELETE", `${homeFiles(agent)}/notes.md`);
  assert.equal(removed.status, 204, removed.text);
  assert.deepEqual((await inW1(server, "GET", `/v2/agents/${agent}/home/files`)).body.files, []);
  const forgot = await inW1(server, "DELETE", `/v2/agents/${agent}/sign-ins/google`);
  assert.deepEqual([forgot.status, forgot.body.error?.details?.reason], [403, "not_scoped"], forgot.text);

  // validateWorkflow: a workflow binds no MCP tool here, so a tool of the operator's server reads as one of a server saved
  // nowhere, whatever the check reads of the saved servers.
  const check = (tool) => inW1(server, "POST", "/v2/workflows/validate", { body: { workflow: answerFlow(), tools: [tool] } });
  const named = await check("mcp:opsonly/add");
  const unsaved = await check("mcp:nowhere/add");
  assert.equal(named.status, 200, named.text);
  assert.equal(named.text.replaceAll("opsonly", "<server>"), unsaved.text.replaceAll("nowhere", "<server>"));
});

test("a workspace archives, unarchives and deletes its own agent and deletes its own imported package; another workspace's calls change none of them", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const { agent, template } = await seedW1(server);
  const made = await inW1(server, "POST", "/v2/agents", { body: { definition: { version: 1, name: "W1 spare", instructions: "Answer.", skills: [], tools: [] } } });
  assert.equal(made.status, 201, made.text);
  const spare = made.body.agent_id;
  for (const [method, path] of [["POST", `/v2/agents/${agent}/archive`], ["DELETE", `/v2/agents/${spare}`], ["DELETE", `/v2/templates/${encodeURIComponent(template)}`]]) {
    assert.equal((await inW2(server, method, path)).status, 404, `${method} ${path}`);
  }
  assert.equal((await inW1(server, "GET", `/v2/agents/${agent}`)).body.archived_at, null, "W2's archive changed nothing");
  assert.equal((await inW1(server, "GET", `/v2/templates/${encodeURIComponent(template)}`)).status, 200, "W2's delete changed nothing");

  const archived = await inW1(server, "POST", `/v2/agents/${agent}/archive`);
  assert.equal(archived.status, 200, archived.text);
  assert.notEqual(archived.body.archived_at, null);
  const unarchived = await inW1(server, "POST", `/v2/agents/${agent}/unarchive`);
  assert.equal(unarchived.status, 200, unarchived.text);
  assert.equal(unarchived.body.archived_at, null);
  assert.deepEqual(unarchived.body.triggers_off, []);

  assert.equal((await inW1(server, "POST", `/v2/agents/${spare}/archive`)).status, 200);
  const deleted = await inW1(server, "DELETE", `/v2/agents/${spare}`);
  assert.equal(deleted.status, 204, deleted.text);
  assert.ok(!TABLE.listAgents.list((await inW1(server, "GET", "/v2/agents")).body).includes(spare), "the purged agent is not listed");

  const gone = await inW1(server, "DELETE", `/v2/templates/${encodeURIComponent(template)}`);
  assert.equal(gone.status, 204, gone.text);
  assert.equal((await inW1(server, "GET", `/v2/templates/${encodeURIComponent(template)}`)).status, 404);
  const bundled = await inW1(server, "DELETE", "/v2/templates/deployed");
  assert.deepEqual([bundled.status, bundled.body.error?.code], [403, "forbidden"], bundled.text);
});

test("with no header, the operator archives, unarchives and deletes any agent as before, and a template's delete stays refused on an API-only server", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const { agent, template } = await seedW1(server);
  const archived = await unscoped(server, "POST", `/v2/agents/${agent}/archive`);
  assert.equal(archived.status, 200, archived.text);
  assert.equal((await unscoped(server, "POST", `/v2/agents/${agent}/unarchive`)).status, 200);
  const made = await inW2(server, "POST", "/v2/agents", { body: { definition: { version: 1, name: "W2 spare", instructions: "Answer.", skills: [], tools: [] } } });
  assert.equal((await unscoped(server, "POST", `/v2/agents/${made.body.agent_id}/archive`)).status, 200);
  assert.equal((await unscoped(server, "DELETE", `/v2/agents/${made.body.agent_id}`)).status, 204, "another workspace's agent, with no header");
  for (const id of [template, "deployed"]) {
    const refused = await unscoped(server, "DELETE", `/v2/templates/${encodeURIComponent(id)}`);
    assert.deepEqual([refused.status, refused.body.error?.code], [404, "not_found"], refused.text);
    assert.match(refused.body.error.message, /serves the run API only/);
  }
  assert.equal((await inW1(server, "GET", `/v2/templates/${encodeURIComponent(template)}`)).status, 200, "W1's package stands");
});

test("a workspace's template delete whose ownership read went stale removes nothing of the package another workspace imported since", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const deps = { registry, store: { importedTemplates: store.importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const upload = (content) => ({ files: [{ path: "agent.md", encoding: "utf8", content }] });
  const signal = AbortSignal.timeout(30_000);
  assert.equal((await inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED), signal))).status, 201);
  await inWorkspace(W1, () => deleteTemplate(deps, "upload:notes"));
  const theirs = await inWorkspace(W2, () => importTemplate(deps, upload(UPLOADED.replace("Answers a question.", "W2's.")), signal));
  assert.equal(theirs.status, 201);
  // W1's second delete read W1's ownership before the first one landed; it reaches the store only now.
  await assert.rejects(inWorkspace(W1, () => deleteTemplate(deps, "upload:notes")), (error) => error.code === "not_found");
  assert.equal((await store.importedTemplates.workspaces()).get("upload:notes"), W2, "W2's row stands");
  assert.equal(registry.get("upload:notes").origin.sha, theirs.pkg.origin.sha, "and is the one served");
});

test("the operator's import of a name sent between a template delete's store delete and its registry's lands after the delete, kept and served", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const deps = { registry, store: { importedTemplates: store.importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const upload = (content) => ({ files: [{ path: "agent.md", encoding: "utf8", content }] });
  const signal = AbortSignal.timeout(30_000);
  assert.equal((await inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED), signal))).status, 201);
  let theirs;
  const racing = { ...deps, store: { importedTemplates: { ...store.importedTemplates, remove: async (id, workspace, read) => {
    const removed = await store.importedTemplates.remove(id, workspace, read);
    // Another workspace's import of the name is refused here (the registry still serves W1's package); the operator's,
    // with no header, is not: it waits for the name the delete holds.
    theirs = outsideWorkspace(() => importTemplate(deps, upload(UPLOADED.replace("Answers a question.", "The operator's.")), signal));
    await until(() => templateNames(registry).waiting(id) > 0, 10_000, "the operator's import never waited for the name");
    return removed;
  } }, settings: store.settings } };
  await inWorkspace(W1, () => deleteTemplate(racing, "upload:notes"));
  theirs = await theirs;
  assert.equal(theirs.status, 201);
  assert.equal((await store.importedTemplates.workspaces()).get("upload:notes"), null, "the operator's row");
  assert.equal(registry.get("upload:notes")?.origin.sha, theirs.pkg.origin.sha, "the operator's package is still served");
});

test("a workspace's reimport of a package its delete is removing, sent while the store's delete runs, lands after the delete, kept and served", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const deps = { registry, store: { importedTemplates: store.importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const upload = (content) => ({ files: [{ path: "agent.md", encoding: "utf8", content }] });
  const signal = AbortSignal.timeout(30_000);
  assert.equal((await inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED), signal))).status, 201);
  let again;
  const racing = { ...deps, store: { importedTemplates: { ...store.importedTemplates, remove: async (id, workspace, read) => {
    // The reimport starts while the delete waits on its statement, and waits for the name the delete holds.
    again = inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED.replace("Answers a question.", "Its second version.")), signal));
    await until(() => templateNames(registry).waiting(id) > 0, 10_000, "the reimport never waited for the name");
    return store.importedTemplates.remove(id, workspace, read);
  } }, settings: store.settings } };
  await inWorkspace(W1, () => deleteTemplate(racing, "upload:notes"));
  again = await again;
  assert.equal(again.status, 201);
  const row = (await store.importedTemplates.list()).find((one) => one.id === "upload:notes");
  assert.equal(row?.sha, again.pkg.origin.sha, "the reimport's row is kept");
  assert.equal(registry.get("upload:notes")?.origin.sha, again.pkg.origin.sha, "and its package served");
  assert.equal((await store.importedTemplates.workspaces()).get("upload:notes"), W1);
});

test("a workspace's delete whose row another server on the store replaced after the delete read it is 404, and that row stands", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const deps = { registry, store: { importedTemplates: store.importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const upload = (content) => ({ files: [{ path: "agent.md", encoding: "utf8", content }] });
  const signal = AbortSignal.timeout(30_000);
  assert.equal((await inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED), signal))).status, 201);
  const theirs = { id: "upload:notes", source: "upload:notes", sha: "f".repeat(64), publisher: "", files: { "agent.md": Buffer.from(UPLOADED.replace("Answers a question.", "Another server's.")).toString("base64") } };
  const racing = { ...deps, store: { importedTemplates: { ...store.importedTemplates, remove: async (id, workspace, read) => {
    // Another server's reimport, on the same store, lands before this delete's statement runs: no lock here holds it.
    assert.equal(await store.importedTemplates.put(theirs, W1), true);
    return store.importedTemplates.remove(id, workspace, read);
  } }, settings: store.settings } };
  await assert.rejects(inWorkspace(W1, () => deleteTemplate(racing, "upload:notes")), (error) => error.code === "not_found");
  const row = (await store.importedTemplates.list()).find((one) => one.id === "upload:notes");
  assert.equal(row?.sha, theirs.sha, "the other server's row is kept");
  assert.equal((await store.importedTemplates.workspaces()).get("upload:notes"), W1);
});

test("a reimport racing its package's delete leaves no ghost: the registry serves the name only while the store keeps its row, and the name stays the workspace's to import", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const deps = { registry, store: { importedTemplates: store.importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const upload = (content) => ({ files: [{ path: "agent.md", encoding: "utf8", content }] });
  const signal = AbortSignal.timeout(30_000);
  assert.equal((await inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED), signal))).status, 201);
  // The reimport's row is committed before the delete reads the row, and its write answers only once the delete is
  // done, so its package would reach the registry after the delete dropped the registry's copy (a store whose answer
  // lags its commit, as a pooled Postgres connection's can).
  let kept = false;
  let deleted;
  const deleteDone = new Promise((resolve) => { deleted = resolve; });
  const lagging = { ...store.importedTemplates, put: async (row, workspace) => { const done = await store.importedTemplates.put(row, workspace); kept = true; await deleteDone; return done; } };
  let again;
  const racing = { ...deps, store: { importedTemplates: { ...store.importedTemplates, stamp: async (id) => {
    again = inWorkspace(W1, () => importTemplate({ ...deps, store: { importedTemplates: lagging, settings: store.settings } }, upload(UPLOADED.replace("Answers a question.", "Its second version.")), signal));
    // On until the reimport kept its row, or waits for the name the delete holds.
    await until(() => kept || (templateNames?.(registry).waiting(id) ?? 0) > 0, 10_000, "the reimport neither kept its row nor waited for the name");
    return store.importedTemplates.stamp(id);
  } }, settings: store.settings } };
  const deleting = await inWorkspace(W1, () => deleteTemplate(racing, "upload:notes")).then(() => 204, (error) => error.code);
  deleted();
  again = await again;
  const row = (await store.importedTemplates.list()).find((one) => one.id === "upload:notes");
  assert.equal(registry.get("upload:notes")?.origin.sha ?? null, row?.sha ?? null, `the registry serves what the store keeps (delete ${deleting}, reimport ${again.status})`);
  assert.equal((await inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED.replace("Answers a question.", "Its third version.")), signal))).status, 201, "the name is still W1's to import");
  await inWorkspace(W1, () => deleteTemplate(deps, "upload:notes"));
  assert.equal(registry.get("upload:notes"), undefined);
});

test("a template delete reads the one package's sha and import time, never every package's files", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const deps = { registry, store: { importedTemplates: store.importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const signal = AbortSignal.timeout(30_000);
  assert.equal((await inWorkspace(W1, () => importTemplate(deps, { files: [{ path: "agent.md", encoding: "utf8", content: UPLOADED }] }, signal))).status, 201);
  const noList = { ...deps, store: { importedTemplates: { ...store.importedTemplates, list: async () => { throw new Error("a delete read every package"); } }, settings: store.settings } };
  await inWorkspace(W1, () => deleteTemplate(noList, "upload:notes"));
  assert.equal(await store.importedTemplates.stamp("upload:notes"), undefined, "the row is gone");
  assert.equal(registry.get("upload:notes"), undefined, "and the package no longer served");
});

test("an Idempotency-Key used in one workspace starts afresh in another, and replays in its own", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const key = { "idempotency-key": "apply-once" };
  const first = await inW1(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: {} }, headers: key });
  assert.equal(first.status, 201, first.text);
  const again = await inW1(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: {} }, headers: key });
  assert.deepEqual([again.headers.get("idempotent-replayed"), again.body.agent_id], ["true", first.body.agent_id], "W1's retry replays");
  const other = await inW2(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: {} }, headers: key });
  assert.equal(other.status, 201, other.text);
  assert.equal(other.headers.get("idempotent-replayed"), null, "W2's is no replay");
  assert.notEqual(other.body.agent_id, first.body.agent_id, "W2 gets an agent of its own");
  assert.equal((await inW2(server, "GET", `/v2/agents/${first.body.agent_id}`)).status, 404);
  // A run start under the same key on each workspace's agent: each its own run.
  const runKey = { "idempotency-key": "run-once" };
  const r1 = await inW1(server, "POST", `/v2/agents/${first.body.agent_id}/runs`, { body: { input: { content: "Hi." } }, headers: runKey });
  const r2 = await inW2(server, "POST", `/v2/agents/${other.body.agent_id}/runs`, { body: { input: { content: "Hi." } }, headers: runKey });
  assert.deepEqual([r1.status, r2.status], [202, 202]);
  assert.notEqual(r1.body.run_id, r2.body.run_id);
});

test("a listed token without the header is 403; the header off an API-only server, or from any credential but a server token, or malformed, is 400; a scoped call outside the set is 403 not_scoped", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const bare = await send(server, "GET", "/v2/runs");
  assert.deepEqual([bare.status, bare.body.error?.code], [403, "forbidden"], bare.text);
  assert.match(bare.body.error.message, /AgentRun-Workspace/);
  assert.equal((await unscoped(server, "GET", "/v2/runs")).status, 200, "the operator's token is served unscoped");
  for (const token of [null, "not-a-token-of-this-server-at-all-000000"]) {
    const answer = await send(server, "GET", "/v2/runs", { workspace: W1, token });
    assert.deepEqual([answer.status, answer.body.error?.code], [400, "bad_request"], `${token}: ${answer.text}`);
  }
  for (const workspace of ["", "has space", "slash/no", "x".repeat(129), "pipe|no"]) {
    const answer = await send(server, "GET", "/v2/runs", { workspace });
    assert.deepEqual([answer.status, answer.body.error?.code], [400, "bad_request"], `${JSON.stringify(workspace)}: ${answer.text}`);
  }
  assert.equal((await send(server, "GET", "/v2/runs", { workspace: "x".repeat(128) })).status, 200, "128 characters is a name");
  for (const [method, path] of [["DELETE", "/v2/agents/a1/learning"], ["GET", "/v2/usage"], ["GET", "/v2/runs/r1/usage"], ["POST", "/v2/runs/r1/approvals/ap1"], ["PUT", `${homeFiles("a1")}/notes.md`], ["POST", "/v2/triggers/t1/secret"], ["POST", "/v2/runs"]]) {
    const answer = await inW1(server, method, path, method === "GET" || method === "DELETE" ? {} : { body: {} });
    assert.deepEqual([answer.status, answer.body.error?.code, answer.body.error?.details?.reason], [403, "forbidden", "not_scoped"], `${method} ${path}: ${answer.text}`);
  }
  const unknown = await inW1(server, "GET", "/v2/nothing-here");
  assert.equal(unknown.status, 404, unknown.text);

  const whole = await serve(t, { runner: false });
  const refused = await fetch(`${whole.url}/v2/runs`, { headers: { authorization: `Bearer ${whole.token}`, "agentrun-workspace": W1 } });
  assert.equal(refused.status, 400, "off an API-only server");
  assert.equal((await refused.json()).error.code, "bad_request");
  assert.equal((await fetch(`${whole.url}/v2/runs`, { headers: { authorization: `Bearer ${whole.token}` } })).status, 200, "and served as before without it");
});

test("a run started unscoped on a workspace's agent reads as that workspace's", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const { agent } = await seedW1(server);
  // The operator's backend starts it with no header (a trigger's dispatch, say): the run carries no workspace of its own.
  const unscopedApply = await unscoped(server, "POST", `/v2/agents/${agent}/runs`, { body: { input: { content: "Dispatched." } } });
  assert.equal(unscopedApply.status, 202, unscopedApply.text);
  const run = unscopedApply.body.run_id;
  assert.equal((await inW1(server, "GET", `/v2/runs/${run}`)).status, 200, "W1 reads it");
  assert.ok(TABLE.listAllRuns.list((await inW1(server, "GET", "/v2/runs")).body).includes(run), "W1 lists it");
  assert.equal((await inW2(server, "GET", `/v2/runs/${run}`)).status, 404, "W2 does not");
  assert.ok(!TABLE.listAllRuns.list((await inW2(server, "GET", "/v2/runs")).body).includes(run));
});

test("a run's file_ids naming a file out of its workspace reads as no file", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const { agent } = await seedW1(server);
  const file = await unscoped(server, "POST", "/v2/files", { body: { path: "notes.md", size_bytes: 5 } });
  assert.equal(file.status, 201, file.text);
  const id = file.body.file.file_id;
  assert.equal(file.body.file.workspace, undefined, "no answer names a workspace");
  const scoped = await inW1(server, "POST", `/v2/agents/${agent}/runs`, { body: { input: { content: "Read it." }, file_ids: [id] } });
  assert.equal(scoped.status, 422, scoped.text);
  assert.equal(scoped.body.error.fields[0].message, `There is no file ${id}: reserve it with POST /v2/files.`);
});

test("AGENTRUN_WORKSPACE_TOKENS names tokens the server takes, on an API-only server alone", async () => {
  assert.deepEqual(workspaceTokensFrom(undefined, ["default"], false), []);
  assert.deepEqual(workspaceTokensFrom(" v2, v2 ops ", ["default", "v2", "ops"], true), ["v2", "ops"]);
  assert.throws(() => workspaceTokensFrom("v2", ["v2"], false), /AGENTRUN_WORKSPACE_TOKENS is set on a server that is not API-only/);
  assert.throws(() => workspaceTokensFrom("v3", ["v2"], true), /AGENTRUN_WORKSPACE_TOKENS names v3, which no token in AGENTRUN_TOKENS is/);
});

test("the workspace migration (0033) is additive: a runner of the build before it opens a schema migrated through it", () => {
  const step = migrationsIn().find((m) => m.name === "workspace");
  assert.ok(step, "0033_workspace.sql ships");
  assert.equal(step.version, 33);
  assert.equal(step.breaking, false, "no runner reads or writes a workspace");
  assert.match(step.sql, /ALTER TABLE agents ADD COLUMN IF NOT EXISTS workspace TEXT COLLATE "C"/);
  assert.match(step.sql, /ALTER TABLE runs ADD COLUMN IF NOT EXISTS workspace TEXT COLLATE "C"/);
  assert.match(step.sql, /ALTER TABLE imported_templates ADD COLUMN IF NOT EXISTS workspace TEXT COLLATE "C"/);
  assert.match(step.sql, /agents \(workspace, created_at\)/);
  assert.match(step.sql, /runs \(workspace, started_at\)/);
  assert.match(step.sql, /schema_version = 33/);
  const floor = Math.max(...migrationsIn().filter((m) => m.version <= 33 && m.breaking).map((m) => m.version));
  assert.equal(runnerOn({ version: 33, runnerFloor: floor }, 32), "opens");
});

test("on SQLite the server adds the workspace columns to a store an earlier build of its version made, every row unscoped; its runner waits for it", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "store.sqlite");
  const first = await openSqliteStore({ file });
  await first.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await first.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  await first.close();
  // An earlier build of this version: no workspace columns, nor their indexes.
  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX agents_by_workspace; DROP INDEX runs_by_workspace; ALTER TABLE agents DROP COLUMN workspace; ALTER TABLE runs DROP COLUMN workspace; ALTER TABLE imported_templates DROP COLUMN workspace");
  raw.close();
  // A claim reads its run's workspace (runner/github-app.ts): a runner waits for the server that adds the columns.
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error instanceof StoreAwaitsServer && /agents\.workspace, runs\.workspace/.test(error.message));
  const server = await openSqliteStore({ file });
  t.after(() => server.close());
  assert.equal((await server.schemaState()).version, SCHEMA_VERSION, "no version step");
  await (await openSqliteStore({ file, role: "runner" })).close();
  await workspaceRows(server);
});

test("on Postgres the store keeps each agent's, run's and imported package's workspace, migrated through 0033", postgresOnly("the Postgres store"), async (t) => {
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const store = await openPostgresStore({ url: PG_URL, schema });
  try {
    assert.equal((await store.schemaState()).version, Math.max(...migrationsIn().map((one) => one.version)), "every migration applied, 0033 among them");
    await store.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
    await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
    await workspaceRows(store);
    await store.agents.create({ id: "agent-2", name: "Agent two", workspace: W2 }, { id: "rev-2", kind: "agentic", body: { instructions: "Answer." } });
    assert.equal(await store.agents.workspace("agent-2"), W2);
    assert.deepEqual((await store.agents.list({ workspace: W2 })).map((a) => a.id), ["agent-2"]);
    await store.importedTemplates.put({ id: "pkg-1", source: "upload:pkg-1", sha: "a".repeat(40), publisher: "", files: {} }, W1);
    await store.importedTemplates.put({ id: "pkg-2", source: "upload:pkg-2", sha: "b".repeat(40), publisher: "", files: {} });
    assert.deepEqual(Object.fromEntries(await store.importedTemplates.workspaces()), { "pkg-1": W1, "pkg-2": null });
  } finally {
    await store.close();
  }
});

/** `agent-1` (run `run-1`) made unscoped on `store`: its workspace, its runs', the lists' filters and the backfill's adopt. */
async function workspaceRows(server) {
  assert.equal(await server.agents.workspace("agent-1"), null);
  assert.equal(await server.runs.workspace("run-1"), null);
  assert.equal(await server.agents.workspace("agent-none"), undefined);
  // An agent's workspace: its runs follow it, lists filter on it, and the backfill's adopt sets only an unscoped one.
  assert.equal(await server.agents.adoptWorkspace("agent-1", W1), W1);
  assert.equal(await server.runs.workspace("run-1"), W1);
  assert.equal(await server.agents.adoptWorkspace("agent-1", W2), W1, "kept");
  assert.deepEqual((await server.agents.list({ workspace: W1 })).map((a) => a.id), ["agent-1"]);
  assert.deepEqual((await server.agents.list({ workspace: W2 })).map((a) => a.id), []);
  assert.deepEqual((await server.runs.listed({ workspace: W2, archived: false, limit: 10, offset: 0 })).rows, []);
  assert.deepEqual((await server.runs.listed({ workspace: W1, archived: false, limit: 10, offset: 0 })).rows.map(({ row }) => row.id), ["run-1"]);
  // A run made in a workspace keeps its own: it reads as that one's whatever its agent's.
  await server.runs.create({ id: "run-2", agentId: "agent-1", revisionId: "rev-1", workspace: W2 });
  assert.equal(await server.runs.workspace("run-2"), W2);
  assert.deepEqual((await server.runs.listed({ workspace: W2, archived: false, limit: 10, offset: 0 })).rows.map(({ row }) => row.id), ["run-2"]);
  // The Agent Factory's list (Runs.list with a scope) selects the workspace's runs the same way, before its limit.
  assert.deepEqual((await server.runs.list({ scope: "active", workspace: W1, limit: 1 })).map((row) => row.id), ["run-1"]);
  assert.deepEqual((await server.runs.list({ scope: "active", workspace: W2, limit: 1 })).map((row) => row.id), ["run-2"]);
}

test("workspace-backfill sets agents with no workspace, refuses one in another, and writes nothing without --apply", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  const store = await openSqliteStore({ file: join(data, "store.sqlite") });
  for (const id of ["a-free", "a-held", "a-same"]) await store.agents.create({ id, name: id, ...(id === "a-held" ? { workspace: W2 } : id === "a-same" ? { workspace: W1 } : {}) }, { id: `rev-${id}`, kind: "agentic", body: { instructions: "Answer." } });
  await store.close();
  const map = join(dir, "map.json");
  writeFileSync(map, JSON.stringify({ "a-free": W1, "a-held": W1, "a-same": W1, "a-none": W1 }));
  const lines = [];
  const io = { out: (line) => lines.push(line), err: (line) => lines.push(`err ${line}`) };
  assert.equal(await workspaceBackfillMain([map, "--data", data], data, "usage", io), 1);
  assert.deepEqual(lines, [`a-free\twould be set to ${W1}`, `a-held\trefused: it is in ${W2}, kept`, `a-same\talready in ${W1}`, "a-none\trefused: no agent of that id", "nothing was written: run again with --apply to set them"]);
  const check = await openSqliteStore({ file: join(data, "store.sqlite") });
  assert.equal(await check.agents.workspace("a-free"), null, "the dry run wrote nothing");
  assert.deepEqual((await backfillWorkspaces(check, { "a-free": W1, "a-held": W1, "a-same": W1 }, true)).map((one) => one.outcome), ["set", "refused", "already"]);
  assert.deepEqual([await check.agents.workspace("a-free"), await check.agents.workspace("a-held")], [W1, W2]);
  await check.close();
  assert.equal(typeof backfillMapOf("[]"), "string");
  assert.equal(typeof backfillMapOf('{"a": "bad name"}'), "string");
  assert.equal(await workspaceBackfillMain([], data, "usage", io), 2);
});

/** On Postgres, the server a test starts opens a schema of its own (AGENTRUN_STORE_URL and AGENTRUN_STORE_SCHEMA, as the
 *  server reads them with no launcher), dropped at the test's end; on SQLite, nothing: the server's data directory. */
async function serverStoreOnTarget() {
  if (!onPostgres) return;
  const schema = await freshSchema();
  const before = [process.env.AGENTRUN_STORE_URL, process.env.AGENTRUN_STORE_SCHEMA];
  process.env.AGENTRUN_STORE_URL = PG_URL;
  process.env.AGENTRUN_STORE_SCHEMA = schema;
  atTestEnd(async () => {
    for (const [name, value] of [["AGENTRUN_STORE_URL", before[0]], ["AGENTRUN_STORE_SCHEMA", before[1]]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await dropSchema(schema);
  });
}

test("a scoped request's Agent Factory pages (scope=active, scope=review) hold its workspace's runs alone, paged within it", { timeout: 120_000 }, async (t) => {
  await serverStoreOnTarget();
  const server = await scopedServer(t);
  assert.equal((await server.store.schemaState()).version, onPostgres ? Math.max(...migrationsIn().map((one) => one.version)) : SCHEMA_VERSION, "the server's store is this run's: Postgres or SQLite");
  const definition = (name) => ({ definition: { version: 1, name, instructions: "Answer.", skills: [], tools: [] } });
  const a1 = (await inW1(server, "POST", "/v2/agents", { body: definition("W1 agent") })).body.agent_id;
  const a2 = (await inW2(server, "POST", "/v2/agents", { body: definition("W2 agent") })).body.agent_id;
  const start = async (request, agent) => {
    const answer = await request(server, "POST", `/v2/agents/${agent}/runs`, { body: { input: { content: "Hello." } } });
    assert.equal(answer.status, 202, answer.text);
    return answer.body.run_id;
  };
  // A failed run is one for review; a queued one is active.
  const fail = async (id) => {
    const claim = await server.store.claim(id, "runner-test", { leaseMs: 60_000 });
    await server.store.runs.update(claim, { state: "failed", endedAt: Date.now() });
  };
  const w1Active = await start(inW1, a1), w1Review = await start(inW1, a1), w1Unscoped = await start(unscoped, a1);
  const w2Active = await start(inW2, a2), w2Review = await start(inW2, a2);
  await fail(w1Review);
  await fail(w2Review);
  const page = async (request, path) => {
    const answer = await request(server, "GET", path);
    assert.equal(answer.status, 200, `${path}: ${answer.text}`);
    return answer.body;
  };
  const ids = async (request, path) => new Set((await page(request, path)).runs.map((run) => run.run_id));
  assert.deepEqual(await ids(inW1, "/v2/runs?scope=active"), new Set([w1Active, w1Unscoped]), "W1's active runs, the one started unscoped on its agent too");
  assert.deepEqual(await ids(inW1, "/v2/runs?scope=review"), new Set([w1Review]));
  assert.deepEqual(await ids(inW2, "/v2/runs?scope=active"), new Set([w2Active]));
  assert.deepEqual(await ids(inW2, "/v2/runs?scope=review"), new Set([w2Review]));
  assert.deepEqual(await ids(inW1, `/v2/agents/${a1}/runs?scope=active`), new Set([w1Active, w1Unscoped]));
  // A page of one, then the next by its cursor: W1's two active runs and no more, none of W2's filling a page.
  const paged = [];
  for (let cursor = null, pages = 0; pages < 4; pages++) {
    const body = await page(inW1, `/v2/runs?scope=active&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    paged.push(...body.runs.map((run) => run.run_id));
    if ((cursor = body.next_cursor) === null) break;
  }
  assert.deepEqual(new Set(paged), new Set([w1Active, w1Unscoped]));
  assert.equal(paged.length, 2);
  // The operator's unscoped token reads every workspace's, as before.
  assert.deepEqual(await ids(unscoped, "/v2/runs?scope=active"), new Set([w1Active, w1Unscoped, w2Active]));
  assert.deepEqual(await ids(unscoped, "/v2/runs?scope=review"), new Set([w1Review, w2Review]));
});

test("two workspaces importing one new package name at once, on two servers of one store: one takes it, the other is 409 name_taken, and the name stays the first's", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const rows = store.importedTemplates;
  // W1's import is held after its check (no package of the name yet), before its write, while W2's runs whole on
  // another server (its own registry, so no lock of this one's holds it).
  let reached, release;
  const atWrite = new Promise((resolve) => (reached = resolve));
  const held = new Promise((resolve) => (release = resolve));
  const importedTemplates = { ...rows, put: async (row, workspace) => {
    if (workspace === W1) (reached(), await held);
    return rows.put(row, workspace);
  } };
  const deps = { registry, store: { importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const theirs = { ...deps, registry: new TemplateRegistry([]) };
  const upload = (content) => ({ files: [{ path: "agent.md", encoding: "utf8", content }] });
  const signal = AbortSignal.timeout(30_000);
  const first = inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED), signal));
  first.catch(() => undefined);
  await atWrite;
  const second = await inWorkspace(W2, () => importTemplate(theirs, upload(UPLOADED.replace("Answers a question.", "Answers W2's question.")), signal));
  assert.equal(second.status, 201);
  release();
  await assert.rejects(first, (error) => error.code === "name_taken", "the import held between its check and its write is refused");
  assert.equal((await rows.workspaces()).get("upload:notes"), W2, "W2 keeps the name");
  const kept = (await rows.list()).find((row) => row.id === "upload:notes");
  assert.equal(kept.sha, second.pkg.origin.sha, "W2's package stands, its files as W2 sent them");
  assert.equal(theirs.registry.get("upload:notes").origin.sha, second.pkg.origin.sha, "and is the one served");
  assert.equal(registry.get("upload:notes"), undefined, "the refused import serves nothing");
  // W2 imports its own package again: replaced in place, still W2's.
  const again = await inWorkspace(W2, () => importTemplate(theirs, upload(UPLOADED), signal));
  assert.deepEqual([again.status, again.replaced], [201, second.pkg.origin.sha]);
  assert.equal((await rows.workspaces()).get("upload:notes"), W2);
});

test("workspace-backfill --apply on a SQLite store an earlier build of this version made (no workspace columns) adds them and sets the agents, no server started", sqliteOnly("the SQLite store's columns"), async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  const file = join(data, "store.sqlite");
  const first = await openSqliteStore({ file });
  await first.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await first.close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX agents_by_workspace; DROP INDEX runs_by_workspace; ALTER TABLE agents DROP COLUMN workspace; ALTER TABLE runs DROP COLUMN workspace; ALTER TABLE imported_templates DROP COLUMN workspace");
  raw.close();
  const map = join(dir, "map.json");
  writeFileSync(map, JSON.stringify({ "agent-1": W1 }));
  const lines = [];
  const io = { out: (line) => lines.push(line), err: (line) => lines.push(`err ${line}`) };
  assert.equal(await workspaceBackfillMain([map, "--data", data, "--apply"], data, "usage", io), 0, lines.join("\n"));
  assert.deepEqual(lines, [`agent-1\tset to ${W1}`]);
  const check = await openSqliteStore({ file, role: "runner" });
  t.after(() => check.close());
  assert.equal(await check.agents.workspace("agent-1"), W1);
});

test("workspace-backfill refuses a Postgres store below the workspace migration (0033), exit 2, and migrates nothing", postgresOnly("the Postgres migration"), async (t) => {
  const schema = await freshSchema();
  const sql = await client(schema);
  const before = [process.env.AGENTRUN_STORE_URL, process.env.AGENTRUN_STORE_SCHEMA];
  t.after(async () => {
    for (const [name, value] of [["AGENTRUN_STORE_URL", before[0]], ["AGENTRUN_STORE_SCHEMA", before[1]]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await sql.end();
    await dropSchema(schema);
  });
  await migrate(sql, schema, Date.now(), migrationsIn().filter((m) => m.version < 33));
  const versionNow = async () => Number((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version);
  assert.equal(await versionNow(), 32);
  process.env.AGENTRUN_STORE_URL = PG_URL;
  process.env.AGENTRUN_STORE_SCHEMA = schema;
  const dir = await scratch(t);
  const map = join(dir, "map.json");
  writeFileSync(map, JSON.stringify({ "agent-1": W1 }));
  const lines = [];
  const io = { out: (line) => lines.push(line), err: (line) => lines.push(`err ${line}`) };
  assert.equal(await workspaceBackfillMain([map, "--data", dir, "--apply"], dir, "usage", io), 2, lines.join("\n"));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^err agentrun-serve workspace-backfill: the store is behind this build, and this command never migrates it: .*from version 32 to \d+.*Start a server of this build once \(it applies every migration, the workspace columns' 0033 among them\), then run this again\. Nothing was written\.$/);
  assert.ok(lines[0].includes(`from version 32 to ${Math.max(...migrationsIn().map((m) => m.version))}`), lines[0]);
  assert.equal(await versionNow(), 32, "nothing migrated");
});

test("capabilities say whether this server keeps workspaces apart: features.workspaces, enforced on an API-only server alone, as the served document describes it", { timeout: 120_000 }, async (t) => {
  const routes = [...WORKSPACE_ROUTES].sort();
  const scoped = await scopedServer(t);
  const doc = (await inW1(scoped, "GET", "/v2/openapi.json")).body;
  const described = doc.components.schemas.Features.properties.workspaces;
  assert.ok(described?.description, "the served document describes features.workspaces");
  const check = (body) => assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Capabilities" }, body), [], JSON.stringify(body.features.workspaces));
  for (const answer of [await unscoped(scoped, "GET", "/v2/capabilities"), await inW1(scoped, "GET", "/v2/capabilities")]) {
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.body.features.workspaces, { header: "AgentRun-Workspace", enforced: true, required_for_tokens: true, routes });
    check(answer.body);
  }
  assert.notDeepEqual(schemaProblems(doc, described, { header: "AgentRun-Workspace", enforced: "yes", required_for_tokens: true, routes }), [], "the positive control: a wrong value is seen");
  assert.notDeepEqual(schemaProblems(doc, described, { header: "AgentRun-Workspace", enforced: true, routes }), [], "required_for_tokens is required");
  // API-only with no token that must send it: a request without the header is served unscoped.
  const open = await scopedServer(t, { workspaceTokens: [] });
  const openAnswer = await unscoped(open, "GET", "/v2/capabilities");
  assert.deepEqual(openAnswer.body.features.workspaces, { header: "AgentRun-Workspace", enforced: true, required_for_tokens: false, routes });
  check(openAnswer.body);
  const whole = await serve(t, { runner: false });
  const answer = await whole.api("GET", "/capabilities");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.features.workspaces, { header: "AgentRun-Workspace", enforced: false, required_for_tokens: false, routes }, "a server that is not API-only refuses the header");
  check(answer.body);
});

test("a scoped request's files are its workspace's: made in it, read, sent and deleted in it alone, listed in it page by page, and its own runs take them", { timeout: 120_000 }, async (t) => {
  await serverStoreOnTarget();
  const server = await scopedServer(t);
  const definition = (name) => ({ definition: { version: 1, name, instructions: "Answer.", skills: [], tools: [] } });
  const a1 = (await inW1(server, "POST", "/v2/agents", { body: definition("W1 agent") })).body.agent_id;
  const a2 = (await inW2(server, "POST", "/v2/agents", { body: definition("W2 agent") })).body.agent_id;
  const oneCall = async (workspace, path) => {
    const answer = await bytes(server, workspace, { path });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    assert.equal(answer.body.file.workspace, undefined, "no answer names a workspace");
    return answer.body.file.file_id;
  };
  // W1 reserves one and sends its bytes, and sends another in one call; W2 sends three, the operator one, between them.
  const f1 = await reserved(inW1, server, "notes.md");
  const g1 = await oneCall(W2, "g1.md");
  const f2 = await oneCall(W1, "report.md");
  const g2 = await oneCall(W2, "g2.md");
  const u1 = await oneCall(undefined, "ops.md");
  const g3 = await oneCall(W2, "g3.md");
  assert.equal((await bytes(server, W2, { id: f1 })).status, 404, "W2 sends no bytes to W1's file");
  const sent = await bytes(server, W1, { id: f1 });
  assert.deepEqual([sent.status, sent.body.status], [200, "ready"], JSON.stringify(sent.body));
  // Another workspace's file reads as a missing one, the same 404 to the byte, for a read and a delete.
  for (const method of ["GET", "DELETE"]) {
    const theirs = await inW2(server, method, `/v2/files/${f2}`);
    const missing = await inW2(server, method, `/v2/files/${missingLike(f2)}`);
    assert.equal(theirs.status, 404, theirs.text);
    assert.equal(shape(theirs, f2), shape(missing, missingLike(f2)), `${method}: W1's file reads as a missing one`);
  }
  assert.equal((await inW1(server, "GET", `/v2/files/${f2}`)).status, 200, "W1's file stands");
  // Each workspace lists its own alone, a page of one at a time, none of another's filling a page; the operator all.
  const listed = async (request) => {
    const ids = [];
    let pages = 0;
    for (let cursor = null; pages < 10; ) {
      const answer = await request(server, "GET", `/v2/files?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert.equal(answer.status, 200, answer.text);
      assert.ok(answer.body.files.length === 1, `a full page: ${answer.text}`);
      ids.push(...answer.body.files.map((file) => file.file_id));
      pages += 1;
      if ((cursor = answer.body.next_cursor) === null) break;
    }
    return { ids, pages };
  };
  assert.deepEqual(await listed(inW1), { ids: [f2, f1], pages: 2 });
  assert.deepEqual(await listed(inW2), { ids: [g3, g2, g1], pages: 3 });
  assert.deepEqual((await unscoped(server, "GET", "/v2/files?limit=10")).body.files.map((file) => file.file_id), [g3, u1, g2, f2, g1, f1]);
  // A run takes its own workspace's files; another's, or one made unscoped, reads as no file.
  const run = await inW1(server, "POST", `/v2/agents/${a1}/runs`, { body: { input: { content: "Read them." }, file_ids: [f1, f2] } });
  assert.equal(run.status, 202, run.text);
  for (const id of [f1, u1]) {
    const refused = await inW2(server, "POST", `/v2/agents/${a2}/runs`, { body: { input: { content: "Read it." }, file_ids: [id] } });
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.body.error.fields[0].message, `There is no file ${id}: reserve it with POST /v2/files.`);
  }
  assert.equal((await inW2(server, "POST", `/v2/agents/${a2}/runs`, { body: { input: { content: "Read it." }, file_ids: [g1] } })).status, 202);
  // W1 deletes its own; the operator reads and deletes any.
  assert.equal((await inW1(server, "DELETE", `/v2/files/${f1}`)).status, 204);
  assert.equal((await inW1(server, "GET", `/v2/files/${f1}`)).status, 404);
  assert.equal((await unscoped(server, "GET", `/v2/files/${g1}`)).status, 200);
  assert.equal((await unscoped(server, "DELETE", `/v2/files/${g1}`)).status, 204);
});

test("a scoped file list pages over its workspace's files alone when another workspace's newer files run past one batch of reads", { timeout: 180_000 }, async (t) => {
  await serverStoreOnTarget();
  const server = await scopedServer(t);
  const sent = async (workspace, path) => {
    const answer = await bytes(server, workspace, { path });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    return answer.body.file.file_id;
  };
  // W1's older file sits behind 70 of W2's (past the 64 records the list reads at once), its newer one before them.
  const older = await sent(W1, "older.md");
  const theirs = [];
  for (let i = 0; i < 70; i += 1) theirs.push(await sent(W2, `g${i}.md`));
  const newer = await sent(W1, "newer.md");
  const pages = async (request, limit) => {
    const seen = [];
    for (let cursor = null, n = 0; n < 100; n += 1) {
      const answer = await request(server, "GET", `/v2/files?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert.equal(answer.status, 200, answer.text);
      seen.push(answer.body.files.map((file) => file.file_id));
      if ((cursor = answer.body.next_cursor) === null) break;
    }
    return seen;
  };
  assert.deepEqual(await pages(inW1, 1), [[newer], [older]], "W1's two files, one a page, none of W2's, the last page saying none follows");
  const w2 = await pages(inW2, 50);
  assert.deepEqual(w2.map((page) => page.length), [50, 20]);
  assert.deepEqual(w2.flat(), [...theirs].reverse(), "W2's 70, newest first, each once");
});

test("a scoped run names no Archil disk that is another workspace's agent's own: it reads as a disk Archil does not have; its own agent's, or a disk no agent owns, it names", { timeout: 120_000 }, async (t) => {
  const API = "fake-archil-account-key-0001";
  const REGION = "aws-us-east-1";
  const CUSTOMER = "dsk-c0570000000000c1";
  const W1_DISK = "dsk-0000000000000a01";
  const FREE_DISK = "dsk-0000000000000f01";
  const MISSING = "dsk-0000000000000bad";
  withEnv(t, { ARCHIL_API_KEY: API });
  const control = archilControlFetch({ region: REGION, strict: true, disks: [{ id: CUSTOMER, name: "customer-1" }, { id: W1_DISK, name: "w1-agent" }, { id: FREE_DISK, name: "unscoped-agent" }] });
  const server = await scopedServer(t, { archilControl: { baseUrl: control.baseUrl, fetch: control.fetch } });
  await saveArchilSettings(server.store, { region: REGION, s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  const definition = (name) => ({ definition: { version: 1, name, instructions: "Answer.", skills: [], tools: [] } });
  const a1 = (await inW1(server, "POST", "/v2/agents", { body: definition("W1 agent") })).body.agent_id;
  const a2 = (await inW2(server, "POST", "/v2/agents", { body: definition("W2 agent") })).body.agent_id;
  // An agent in no workspace (made before the header, say), with a disk of its own.
  await server.store.agents.create({ id: "agent-free", name: "Unscoped agent" }, { id: "rev-free", kind: "agentic", body: { instructions: "Answer." } });
  await storeAgentDisk(server.store, a1, { diskId: W1_DISK });
  await storeAgentDisk(server.store, "agent-free", { diskId: FREE_DISK });
  const start = (request, agent, disk) => request(server, "POST", `/v2/agents/${agent}/runs`, { body: { input: { content: "Hello." }, archil_disk: { disk_id: disk } } });
  const missing = await start(inW2, a2, MISSING);
  assert.equal(missing.status, 422, missing.text);
  for (const disk of [W1_DISK, FREE_DISK]) {
    const theirs = await start(inW2, a2, disk);
    assert.equal(theirs.status, 422, theirs.text);
    assert.equal(shape(theirs, disk), shape(missing, MISSING), `${disk}: another's agent disk reads as a missing one`);
  }
  for (const [request, agent, disk, why] of [[inW1, a1, W1_DISK, "W1 names its own agent's disk"], [inW2, a2, CUSTOMER, "a disk no agent owns is the backend's to give"], [unscoped, a1, FREE_DISK, "the operator names any"]]) {
    const answer = await start(request, agent, disk);
    assert.equal(answer.status, 202, `${why}: ${answer.text}`);
  }
});

test("an unscoped import of a package name a workspace holds is 409 name_taken and changes nothing; the operator deletes it first, then imports it", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const deps = { registry, store: { importedTemplates: store.importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const upload = (content, extra = {}) => ({ files: [{ path: "agent.md", encoding: "utf8", content }], ...extra });
  const signal = AbortSignal.timeout(30_000);
  const mine = await inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED), signal));
  assert.equal(mine.status, 201);
  const theirs = UPLOADED.replace("Answers a question.", "The operator's.");
  for (const extra of [{ dry_run: true }, {}]) {
    await assert.rejects(importTemplate(deps, upload(theirs, extra), signal), (error) => error.code === "name_taken" && /DELETE \/v2\/templates\/upload:notes/.test(error.message), JSON.stringify(extra));
  }
  // The store's own write keeps W1's row whatever the check before it found (an operator's import racing W1's).
  assert.equal(await store.importedTemplates.put({ id: "upload:notes", source: "upload:notes", sha: "f".repeat(40), publisher: "", files: {} }), false);
  const kept = (await store.importedTemplates.list()).find((row) => row.id === "upload:notes");
  assert.equal(kept.sha, mine.pkg.origin.sha, "W1's package stands");
  assert.equal((await store.importedTemplates.workspaces()).get("upload:notes"), W1);
  assert.equal(registry.get("upload:notes").origin.sha, mine.pkg.origin.sha, "and is the one served");
  await deleteTemplate(deps, "upload:notes");
  const ops = await importTemplate(deps, upload(theirs), signal);
  assert.deepEqual([ops.status, ops.replaced], [201, null]);
  assert.equal((await store.importedTemplates.workspaces()).get("upload:notes"), null, "the operator's, in no workspace");
  // An unscoped package the operator imports again is replaced in place.
  const again = await importTemplate(deps, upload(UPLOADED), signal);
  assert.deepEqual([again.status, again.replaced], [201, ops.pkg.origin.sha]);
});

test("the trigger engine's timer, armed by a scoped request, fires out of that workspace: a later firing of another workspace's agent starts unscoped", { timeout: 60_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  // As setTimeout does, the timer runs its callback in the context it was armed in.
  const arm = clock.arm;
  clock.arm = (fire, ms) => arm(AsyncResource.bind(fire), ms);
  const { store } = await storeOn(t, { clock: { get now() { return clock.now(); } } });
  for (const [id, workspace] of [["a", W1], ["b", W2]]) await store.agents.create({ id, name: id, workspace }, { id: `rev-${id}`, kind: "agentic", body: {} });
  const started = [];
  const triggers = new Triggers({
    store, clock, targetIssues: async () => [], statusOf: async () => null, runOf: async () => null, notify: () => "queued", say: () => {}, settings: () => ({ mint: () => "unused", remove: () => {} }), message: async () => undefined,
    start: async (target, input, origin) => {
      started.push({ agent: target.agent_id, workspace: workspaceNow() });
      const id = `run-${started.length}`;
      await store.triggers.fire({ triggerId: origin.id, key: origin.firing_key }, { id, agentId: target.agent_id, revisionId: `rev-${target.agent_id}` });
      return { run_id: id };
    },
  });
  t.after(() => triggers.close());
  await triggers.start();
  const schedule = (agent, at) => ({ name: `at ${at}`, source: { kind: "schedule", at }, target: { kind: "start_run", agent_id: agent, input: { content: "Hello." }, max_cost_usd: 0.5 } });
  const a = await triggers.create(schedule("a", "2026-06-01T00:05:00Z"));
  // W2's request makes its agent's trigger, and arms the engine's one timer again, for W1's firing, the soonest.
  await inWorkspace(W2, () => triggers.create(schedule("b", "2026-06-01T00:10:00Z")));
  await until(() => clock.timer !== null && clock.timer.at <= Date.parse("2026-06-01T00:05:00Z"), 5_000, "the timer armed for 00:05");
  clock.to("2026-06-01T00:05:00Z");
  await until(() => started.length === 1, 5_000, "W1's firing started");
  assert.deepEqual(started, [{ agent: "a", workspace: undefined }], "W1's agent's run starts in no request's workspace");
  // A firing a request drives (run now, here in W2's context) is driven as no request's too.
  await inWorkspace(W2, () => triggers.fire(a.id, "now-1"));
  await until(() => started.length === 2, 5_000, "the run-now firing started");
  assert.deepEqual(started[1], { agent: "a", workspace: undefined });
});

test("a scoped run is its agent's workspace's through its agent alone: its row keeps no workspace of the request's", { ...sqliteOnly("the SQLite store's row"), timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const { agent, run } = await seedW1(server);
  const raw = new DatabaseSync(join(server.data, "store.sqlite"), { readOnly: true });
  t.after(() => raw.close());
  assert.deepEqual({ ...raw.prepare("SELECT workspace FROM runs WHERE id = ?").get(run) }, { workspace: null }, "the request's workspace is not written on the run");
  assert.equal(await server.store.runs.workspace(run), W1, "it reads as its agent's");
  assert.equal((await inW1(server, "GET", `/v2/runs/${run}`)).status, 200);
  assert.equal(await server.store.agents.workspace(agent), W1);
});

test("a scoped request starts its own held run: W1's run started with hold: true waits on its computer until W1's start, which answers started, and its agent then runs to its end", { timeout: 120_000 }, async (t) => {
  // --faux's desktop (made at the claim), its model the held fixture's, which never waits unless a test asks it to.
  const server = await scopedServer(t, { runner: true, faux: new URL("./fixtures/faux-desktop-held.mjs", import.meta.url).pathname });
  const desk = await inW1(server, "POST", "/v2/agents", { body: { definition: { version: 1, name: "W1 desk", instructions: "Look at the desktop.", skills: [], tools: [], computer: { kind: "desktop", provider: "faux-desktop" } } } });
  assert.equal(desk.status, 201, desk.text);
  const held = await inW1(server, "POST", `/v2/agents/${desk.body.agent_id}/runs`, { body: { input: { content: "Look at the desktop." }, hold: true, hold_minutes: 5 } });
  assert.equal(held.status, 202, held.text);
  const id = held.body.run_id;
  await until(async () => (await inW1(server, "GET", `/v2/runs/${id}`)).body?.computer?.held?.state === "waiting", 60_000, "W1's held run waits on its computer");
  const started = await inW1(server, TABLE.startRun.method, TABLE.startRun.path.replace("{run}", id), { body: TABLE.startRun.body });
  assert.deepEqual([started.status, started.body], [200, { held: { state: "started" } }], started.text);
  // The agent runs to its end; the run keeps its computer (held: ended) until a release or the hold's lapse.
  await until(async () => (await inW1(server, "GET", `/v2/runs/${id}`)).body?.computer?.held?.state === "ended", 60_000, "W1's started agent runs to its end");
});

/** A phone paired with `server` (not attached): the operator's own machine, one more provider of the phone kind. */
async function pairPhone(server, id) {
  const hello = { protocol: PROTOCOL_VERSION, version: "0", os: "android", kind: "android", arch: "arm64", groups: ["screen", "input.touch", "apps"] };
  await server.store.pairedComputers.addCode(`pairing-${id}`, `code-${id}`, Date.now() + 60_000);
  assert.equal(await server.store.pairedComputers.pair(`code-${id}`, { id, name: "Pixel", hello, labels: {}, tokenSha256: `token-${id}` }), true);
}

test("an agent in a workspace never names a paired computer: a scoped create or edit naming one is 422 at definition.computer, nothing written; on a server with no workspaces the owner's agent names it", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  await pairPhone(server, "cmp-pixel");
  const definition = (name, computer) => ({ definition: { version: 1, name, instructions: "Answer.", skills: [], tools: [], ...(computer ? { computer } : {}) } });
  const phone = { kind: "phone", provider: "cmp-pixel" };
  const refused = await inW1(server, "POST", "/v2/agents", { body: definition("W1 phone", phone) });
  assert.equal(refused.status, 422, refused.text);
  assert.deepEqual(refused.body.error.fields.map(({ field, reason }) => ({ field, reason })), [{ field: "definition.computer", reason: "not_an_option" }]);
  assert.ok(refused.body.error.fields[0].message.startsWith(scopedPairedWords("cmp-pixel")), refused.text);
  assert.deepEqual(TABLE.listAgents.list((await inW1(server, "GET", "/v2/agents")).body), [], "nothing written");
  const made = await inW1(server, "POST", "/v2/agents", { body: definition("W1 agent") });
  assert.equal(made.status, 201, made.text);
  const edit = await inW1(server, "PUT", `/v2/agents/${made.body.agent_id}/definition`, { body: definition("W1 agent", phone) });
  assert.equal(edit.status, 422, edit.text);
  assert.equal(edit.body.error.fields[0].field, "definition.computer");
  assert.ok(edit.body.error.fields[0].message.startsWith(scopedPairedWords("cmp-pixel")), edit.text);
  assert.equal((await inW1(server, "GET", `/v2/agents/${made.body.agent_id}`)).body.version, made.body.version, "no revision written");
  // A server that is not API-only keeps no workspaces: its owner's agent names the phone paired with it.
  const whole = await serve(t, { runner: false });
  await pairPhone(whole, "cmp-pixel");
  const owner = await whole.api("POST", "/agents", definition("Owner phone", phone));
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
});

test("a scoped request's capabilities count no paired computer's kind; the operator's count it", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const kinds = async (request) => (await request(server, "GET", "/v2/capabilities")).body.features.computers.kinds;
  const before = await kinds(unscoped);
  assert.ok(!before.includes("phone"), `no provider here serves a phone: ${before}`);
  await pairPhone(server, "cmp-pixel");
  assert.deepEqual(await kinds(unscoped), [...before, "phone"], "the operator's paired phone");
  assert.deepEqual(await kinds(inW1), before, "a workspace's");
});

test("a workspace never sees a paired computer in Settings → Computers: its list holds no paired one (refused, or served without them), its tests, choices and keys are 403 not_scoped, and the operator's list names it", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  await pairPhone(server, "cmp-pixel");
  const list = await inW1(server, "GET", "/v2/computers");
  if (list.status === 403) assert.equal(list.body.error.details.reason, "not_scoped", list.text);
  else {
    assert.equal(list.status, 200, list.text);
    const ids = [...list.body.kinds.flatMap((kind) => (kind.providers ?? []).map((provider) => provider.id)), ...list.body.paired.map((one) => one.id)];
    assert.deepEqual(ids.filter((id) => id.startsWith("cmp-")), [], "a workspace's list");
  }
  assert.ok(!list.text.includes("cmp-pixel") && !list.text.includes("Pixel"), `a workspace's answer names no paired computer: ${list.text}`);
  for (const [method, path, options] of [["POST", "/v2/computers/cmp-pixel/test"], ["GET", "/v2/computers/cmp-pixel/choices"], ["PUT", "/v2/computers/cmp-pixel/keys", { body: {} }]]) {
    const refused = await inW1(server, method, path, options);
    assert.deepEqual([refused.status, refused.body.error.details.reason], [403, "not_scoped"], `${method} ${path}: ${refused.text}`);
  }
  const listed = await unscoped(server, "GET", "/v2/computers");
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body.paired.map((one) => one.id), ["cmp-pixel"], "the operator's view");
});

test("a workspace's refusal of a paired computer points at what the workspace is served: the kinds its capabilities offer, and any provider of the kind but a paired one", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  await pairPhone(server, "cmp-pixel");
  const refused = await inW1(server, "POST", "/v2/agents", { body: { definition: { version: 1, name: "W1 phone", instructions: "Answer.", skills: [], tools: [], computer: { kind: "phone", provider: "cmp-pixel" } } } });
  assert.equal(refused.status, 422, refused.text);
  const { message } = refused.body.error.fields[0];
  assert.ok(message.startsWith(scopedPairedWords("cmp-pixel")), message);
  assert.doesNotMatch(message, /pick one GET \/v2\/computers lists/, "never a list that holds the paired computer itself");
  assert.match(message, /GET \/v2\/capabilities offers it \(features\.computers\.kinds\)/, "the kinds a workspace's capabilities count, which leave the paired computer out");
  assert.match(message, /never one whose id begins with cmp-/, "and a paired computer is not a provider to name");
});
