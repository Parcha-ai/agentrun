// A request's workspace (workspace-scope.ts): an API-only server's backend names it in the AgentRun-Workspace header,
// with a server token, and the request then reaches that workspace's agents, runs and imported template packages alone.
// Another workspace's row answers the same 404 as a missing one, every list holds the workspace's rows alone, what it
// makes is stamped, and an Idempotency-Key is the workspace's own. A token listed in AGENTRUN_WORKSPACE_TOKENS must send
// the header; the header is refused off an API-only server and from any credential but a server token; a scoped request
// is served only the operations of WORKSPACE_ROUTES. A run made unscoped reads as its agent's workspace's. A request with
// no header is served as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { atTestEnd, client, dropSchema, freshSchema, onPostgres, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";
import { storeOn } from "./store-helpers.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { scratch, serve } from "./support.mjs";

const { WORKSPACE_ROUTES, servedScoped } = await import("../dist/api-only.js");
const { ROUTES } = await import("../dist/server.js");
const { migrate, openPostgresStore, openSqliteStore, migrationsIn, runnerOn } = await import("../dist/store/index.js");
const { SCHEMA_VERSION } = await import("../dist/store/schema.js");
const { workspaceTokensFrom } = await import("../dist/workspace-scope.js");
const { backfillMapOf, backfillWorkspaces, workspaceBackfillMain } = await import("../dist/workspace-backfill.js");
const { importTemplate } = await import("../dist/template-import.js");
const { TemplateRegistry } = await import("../dist/templates.js");
const { inWorkspace } = await import("../dist/workspace-scope.js");

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

/** Every operation of WORKSPACE_ROUTES: how a scoped request reaches it, and what a row of another workspace reads as.
 *  `row`: the operation names W1's row by id (agent, run or template), and W2 gets the 404 a missing id gets. `list`: W2's
 *  list holds none of W1's rows. `made`: a write W2 makes lands in W2 alone. `served`: answered to any workspace. */
const TABLE = {
  getRun: { method: "GET", path: "/v2/runs/{run}", row: "run" },
  getTimeline: { method: "GET", path: "/v2/runs/{run}/timeline", row: "run" },
  listRunFiles: { method: "GET", path: "/v2/runs/{run}/files", row: "run" },
  readRunFile: { method: "GET", path: "/v2/runs/{run}/files/out/report.md", row: "run" },
  getRunExport: { method: "GET", path: "/v2/runs/{run}/export", row: "run" },
  sendMessage: { method: "POST", path: "/v2/runs/{run}/messages", row: "run", body: { content: "More." } },
  stopRun: { method: "POST", path: "/v2/runs/{run}/stop", row: "run", body: {} },
  cancelRun: { method: "POST", path: "/v2/runs/{run}/cancel", row: "run", body: {} },
  getAgent: { method: "GET", path: "/v2/agents/{agent}", row: "agent" },
  listRevisions: { method: "GET", path: "/v2/agents/{agent}/revisions", row: "agent" },
  listRuns: { method: "GET", path: "/v2/agents/{agent}/runs", row: "agent" },
  createRun: { method: "POST", path: "/v2/agents/{agent}/runs", row: "agent", body: { input: { content: "Hello." } } },
  updateDefinition: { method: "PUT", path: "/v2/agents/{agent}/definition", row: "agent", body: { definition: { version: 1, name: "W2 edit", instructions: "Answer.", skills: [], tools: [] } } },
  setCurrent: { method: "POST", path: "/v2/agents/{agent}/current", row: "agent", body: { revision_id: "rev_none" } },
  getTemplate: { method: "GET", path: "/v2/templates/{template}", row: "template" },
  applyTemplate: { method: "POST", path: "/v2/templates/{template}/apply", row: "template", body: { parameters: {} } },
  listAllRuns: { method: "GET", path: "/v2/runs", list: (body) => body.runs.map((one) => one.id ?? one.run_id) , of: "run" },
  listAgents: { method: "GET", path: "/v2/agents", list: (body) => body.agents.map((one) => one.agent_id), of: "agent" },
  listTemplates: { method: "GET", path: "/v2/templates", list: (body) => body.templates.map((one) => one.id), of: "template" },
  createAgent: { made: true },
  importTemplate: { made: true },
  getCapabilities: { method: "GET", path: "/v2/capabilities", served: true },
  getHealth: { method: "GET", path: "/v2/health", served: true },
  getOpenapi: { method: "GET", path: "/v2/openapi.json", served: true },
};

test("every operation of WORKSPACE_ROUTES is a route of the server, and the table below covers each", () => {
  const names = new Set(ROUTES.map((route) => route.name));
  for (const name of WORKSPACE_ROUTES) assert.ok(names.has(name), `${name} is in ROUTES`);
  assert.deepEqual([...WORKSPACE_ROUTES].sort(), Object.keys(TABLE).sort());
  assert.equal(servedScoped(ROUTES, "GET", "/v2/runs/r1"), "served");
  assert.equal(servedScoped(ROUTES, "HEAD", "/v2/agents/a1"), "served");
  assert.equal(servedScoped(ROUTES, "DELETE", "/v2/agents/a1"), "not_scoped");
  assert.equal(servedScoped(ROUTES, "GET", "/v2/usage"), "not_scoped");
  assert.equal(servedScoped(ROUTES, "GET", "/v2/runs/r1/computer/live/v/x"), "not_scoped");
  assert.equal(servedScoped(ROUTES, "GET", "/v2/nothing-here"), "none");
  assert.equal(servedScoped(ROUTES, "GET", "/"), "none");
});

test("a scoped request reads another workspace's row as a missing one, the same 404 to the byte, its lists hold its own rows alone, and its writes are its own", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const w1 = await seedW1(server);
  for (const [name, op] of Object.entries(TABLE)) {
    if (op.row) {
      const id = w1[op.row];
      const path = op.path.replace(`{${op.row}}`, encodeURIComponent(id));
      const theirs = await inW2(server, op.method, path, op.body === undefined ? {} : { body: op.body });
      const missing = await inW2(server, op.method, op.path.replace(`{${op.row}}`, encodeURIComponent(missingLike(id))), op.body === undefined ? {} : { body: op.body });
      assert.equal(theirs.status, 404, `${name}: ${theirs.text}`);
      assert.equal(shape(theirs, id), shape(missing, missingLike(id)), `${name}: W1's ${op.row} reads as a missing one`);
      const own = { run: `/v2/runs/${id}`, agent: `/v2/agents/${id}`, template: `/v2/templates/${encodeURIComponent(id)}` }[op.row];
      assert.equal((await inW1(server, "GET", own)).status, 200, `${name}: W1 reads its own ${op.row}`);
    } else if (op.list) {
      const mine = await inW1(server, op.method, op.path);
      const theirs = await inW2(server, op.method, op.path);
      assert.equal(theirs.status, 200, `${name}: ${theirs.text}`);
      assert.ok(op.list(mine.body).includes(w1[op.of]), `${name}: W1's list holds its ${op.of}`);
      assert.ok(!op.list(theirs.body).includes(w1[op.of]), `${name}: W2's list holds none of W1's`);
    } else if (op.served) {
      assert.equal((await inW2(server, op.method, op.path)).status, 200, name);
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
  for (const [method, path] of [["DELETE", "/v2/agents/a1"], ["GET", "/v2/usage"], ["POST", "/v2/files"], ["GET", "/v2/triggers"], ["POST", "/v2/runs"]]) {
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

test("on SQLite the server adds the workspace columns to a store an earlier build of its version made, every row unscoped, with no wait for its runner", async (t) => {
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
  const runner = await openSqliteStore({ file, role: "runner" });
  await runner.close();
  const server = await openSqliteStore({ file });
  t.after(() => server.close());
  assert.equal((await server.schemaState()).version, SCHEMA_VERSION, "no version step");
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

test("two workspaces importing one new package name at once: one takes it, the other is 409 name_taken, and the name stays the first's", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const rows = store.importedTemplates;
  // W1's import is held after its check (no package of the name yet), before its write, while W2's runs whole.
  let reached, release;
  const atWrite = new Promise((resolve) => (reached = resolve));
  const held = new Promise((resolve) => (release = resolve));
  const importedTemplates = { ...rows, put: async (row, workspace) => {
    if (workspace === W1) (reached(), await held);
    return rows.put(row, workspace);
  } };
  const deps = { registry, store: { importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  const upload = (content) => ({ files: [{ path: "agent.md", encoding: "utf8", content }] });
  const signal = AbortSignal.timeout(30_000);
  const first = inWorkspace(W1, () => importTemplate(deps, upload(UPLOADED), signal));
  first.catch(() => undefined);
  await atWrite;
  const second = await inWorkspace(W2, () => importTemplate(deps, upload(UPLOADED.replace("Answers a question.", "Answers W2's question.")), signal));
  assert.equal(second.status, 201);
  release();
  await assert.rejects(first, (error) => error.code === "name_taken", "the import held between its check and its write is refused");
  assert.equal((await rows.workspaces()).get("upload:notes"), W2, "W2 keeps the name");
  const kept = (await rows.list()).find((row) => row.id === "upload:notes");
  assert.equal(kept.sha, second.pkg.origin.sha, "W2's package stands, its files as W2 sent them");
  assert.equal(registry.get("upload:notes").origin.sha, second.pkg.origin.sha, "and is the one served");
  // W2 imports its own package again: replaced in place, still W2's.
  const again = await inWorkspace(W2, () => importTemplate(deps, upload(UPLOADED), signal));
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
  assert.match(lines[0], /^err agentrun-serve workspace-backfill: the store is behind this build, and this command never migrates it: .*from version 32 to 33.*Start a server of this build once \(it applies every migration, the workspace columns' 0033 among them\), then run this again\. Nothing was written\.$/);
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
    assert.deepEqual(answer.body.features.workspaces, { header: "AgentRun-Workspace", enforced: true, routes });
    check(answer.body);
  }
  assert.notDeepEqual(schemaProblems(doc, described, { header: "AgentRun-Workspace", enforced: "yes", routes }), [], "the positive control: a wrong value is seen");
  const whole = await serve(t, { runner: false });
  const answer = await whole.api("GET", "/capabilities");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.features.workspaces, { header: "AgentRun-Workspace", enforced: false, routes }, "a server that is not API-only refuses the header");
  check(answer.body);
});
