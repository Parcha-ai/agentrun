// An uploaded template package's name is its workspace's own (store `imported_templates`, keyed by workspace and id): two
// workspaces upload a package of one name and each gets its own, `upload:<name>` in both. Each workspace's read, apply,
// reimport and delete reaches its own package alone, and an agent's purge takes its own workspace's upload alone. A
// request with no workspace keeps the packages of none, as a server with no workspaces always did. Postgres migration
// 0035 and SQLite version 19 key the rows each in the workspace it already had.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";
import { storeOn } from "./store-helpers.mjs";
import { scratch, serve, withEnv } from "./support.mjs";
import { fakeClock, hookServer } from "./trigger-support.mjs";

const { migrate, migrationsIn, openPostgresStore, openSqliteStore } = await import("../dist/store/index.js");
const { SCHEMA_VERSION } = await import("../dist/store/schema.js");
const { mintSecret } = await import("../dist/standard-webhooks.js");
const { deleteTemplate, dropRemovedUploads, importTemplate, loadImported } = await import("../dist/template-import.js");
const { TemplateRegistry } = await import("../dist/templates.js");
const { inWorkspace } = await import("../dist/workspace-scope.js");

const SCOPED = randomBytes(24).toString("hex");
const A = "org:team-a";
const B = "org:team-b";
const ID = "upload:notes";

/** A package named `notes`: its description, instructions and one schedule trigger, each its uploader's own. */
const notes = (who, trigger = "morning") => `---
name: notes
version: 1.0.0
description: ${who}'s notes.
budget: { per_run_usd: 0.5 }
tools: []
triggers:
  - name: ${trigger}
    source: { kind: schedule, cron: "0 9 * * *", timezone: UTC }
    target: { kind: start_run, input: { content: "Take ${who}'s notes." } }
---
Take notes for ${who}.
`;
const upload = (content) => ({ files: [{ path: "agent.md", encoding: "utf8", content }] });

/** An API-only server whose token `v2` must name a workspace, with the launch hook, so an apply makes a schedule. */
async function scopedServer(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const hook = await hookServer(t);
  return serve(t, { runner: false, apiOnly: true, tokens: [{ id: "v2", token: SCOPED }], workspaceTokens: ["v2"], triggerClock: fakeClock("2026-06-01T08:00:00Z"), launchHook: { url: hook.url, secret: mintSecret() } });
}

/** One request in `workspace` (none when undefined) with `token`: its status and parsed body. */
async function send(server, workspace, method, path, body, token = SCOPED) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(workspace === undefined ? {} : { "agentrun-workspace": workspace }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

const path = `/v2/templates/${encodeURIComponent(ID)}`;

test("two workspaces upload a package of one name: both 201, and each one's read, list, apply, reimport and delete reach its own package alone", { timeout: 120_000 }, async (t) => {
  const server = await scopedServer(t);
  const inA = (method, to, body) => send(server, A, method, to, body);
  const inB = (method, to, body) => send(server, B, method, to, body);

  const a = await inA("POST", "/v2/templates/import", upload(notes("A")));
  assert.equal(a.status, 201, a.text);
  const b = await inB("POST", "/v2/templates/import", upload(notes("B", "evening")));
  assert.equal(b.status, 201, b.text);
  assert.deepEqual([a.body.template.id, b.body.template.id, b.body.replaced], [ID, ID, null], "B's upload replaced nothing: the name is B's own");
  assert.notEqual(a.body.template.sha, b.body.template.sha);

  // Each read and list is its own workspace's package.
  for (const [request, who, sha] of [[inA, "A", a.body.template.sha], [inB, "B", b.body.template.sha]]) {
    const read = await request("GET", path);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual([read.body.template.sha, read.body.template.description], [sha, `${who}'s notes.`], `${who} reads its own`);
    const listed = (await request("GET", "/v2/templates")).body.templates.filter((one) => one.id === ID);
    assert.deepEqual(listed.map((one) => one.sha), [sha], `${who} lists its own alone`);
  }

  // Each apply makes its agent from its own package, its trigger marked with the package's id.
  const agentA = await inA("POST", `${path}/apply`, { parameters: {} });
  assert.equal(agentA.status, 201, agentA.text);
  const agentB = await inB("POST", `${path}/apply`, { parameters: {} });
  assert.equal(agentB.status, 201, agentB.text);
  for (const [agent, trigger, who] of [[agentA.body.agent_id, "morning", "A"], [agentB.body.agent_id, "evening", "B"]]) {
    assert.deepEqual((await server.store.triggers.list(agent)).map((row) => [row.name, row.templateId]), [[trigger, ID]], `${who}'s agent has its own package's trigger`);
  }
  // A's reimport replaces A's package alone; A's apply onto its agent again keeps A's trigger and touches none of B's.
  const again = await inA("POST", "/v2/templates/import", upload(notes("A").replace("Take notes for A.", "Take short notes for A.")));
  assert.deepEqual([again.status, again.body.replaced], [201, a.body.template.sha], again.text);
  const updated = await inA("POST", `${path}/apply`, { parameters: {}, agent_id: agentA.body.agent_id });
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual((await server.store.triggers.list(agentA.body.agent_id)).map((row) => [row.name, row.templateId]), [["morning", ID]]);
  assert.deepEqual((await server.store.triggers.list(agentB.body.agent_id)).map((row) => [row.name, row.templateId]), [["evening", ID]]);
  assert.equal((await inB("GET", path)).body.template.sha, b.body.template.sha, "B's package is as B sent it");

  // B's delete takes B's package alone; A's still reads, lists and applies.
  assert.equal((await inB("DELETE", path)).status, 204);
  assert.equal((await inB("GET", path)).status, 404);
  assert.equal((await inB("DELETE", path)).status, 404, "nothing of B's is left to delete");
  assert.equal((await inA("GET", path)).body.template.sha, again.body.template.sha, "A's package stands");
  assert.equal((await inA("POST", `${path}/apply`, { parameters: {}, dry_run: true })).status, 200);
  assert.equal((await inA("DELETE", path)).status, 204);
  assert.equal((await inA("GET", path)).status, 404);
});

/** The registry and the store an import, apply and delete reach directly (template-import.ts), with no GitHub read. */
async function importsOn(t) {
  const { store } = await storeOn(t);
  const registry = new TemplateRegistry([]);
  const deps = { registry, store: { importedTemplates: store.importedTemplates, settings: store.settings }, reach: async () => { throw new Error("no GitHub read here"); }, apiOnly: true };
  return { store, registry, deps, signal: AbortSignal.timeout(30_000) };
}

test("each workspace's import, delete and reimport of one name keeps its own row, on the store itself", { timeout: 60_000 }, async (t) => {
  const { store, registry, deps, signal } = await importsOn(t);
  const a = await inWorkspace(A, () => importTemplate(deps, upload(notes("A")), signal));
  const b = await inWorkspace(B, () => importTemplate(deps, upload(notes("B")), signal));
  const none = await importTemplate(deps, upload(notes("the operator")), signal);
  assert.deepEqual([a.status, b.status, none.status], [201, 201, 201]);
  assert.deepEqual([a.replaced, b.replaced, none.replaced], [null, null, null]);
  const keys = async () => (await store.importedTemplates.keys()).map((key) => `${key.workspace}|${key.id}`).sort();
  assert.deepEqual(await keys(), [`${A}|${ID}`, `${B}|${ID}`, `null|${ID}`]);
  const shaIn = async (workspace) => (await store.importedTemplates.list()).find((row) => row.id === ID && row.workspace === workspace)?.sha;
  assert.deepEqual([await shaIn(A), await shaIn(B), await shaIn(null)], [a.pkg.origin.sha, b.pkg.origin.sha, none.pkg.origin.sha]);
  assert.deepEqual([inWorkspace(A, () => registry.get(ID)), inWorkspace(B, () => registry.get(ID)), registry.get(ID)].map((pkg) => pkg?.origin.sha), [a.pkg.origin.sha, b.pkg.origin.sha, none.pkg.origin.sha], "each served to its own");
  assert.deepEqual(inWorkspace(A, () => registry.list()).map((pkg) => pkg.origin.sha), [a.pkg.origin.sha], "A's list holds its own alone");

  // B's delete, and the store's own delete and read in B, never reach A's row.
  await inWorkspace(B, () => deleteTemplate(deps, ID));
  assert.equal(await store.importedTemplates.remove(ID, B), false);
  assert.equal(await store.importedTemplates.remove(ID, B, await store.importedTemplates.stamp(ID, A)), false, "A's row read, removed in B: nothing");
  assert.equal(await store.importedTemplates.stamp(ID, B), undefined);
  assert.deepEqual(await keys(), [`${A}|${ID}`, `null|${ID}`]);
  assert.equal(inWorkspace(A, () => registry.get(ID))?.origin.sha, a.pkg.origin.sha, "A's package is still served");
  assert.equal(inWorkspace(B, () => registry.get(ID)), undefined);
  await assert.rejects(inWorkspace(B, () => deleteTemplate(deps, ID)), (error) => error.code === "not_found");

  // A's reimport replaces A's alone.
  const again = await inWorkspace(A, () => importTemplate(deps, upload(notes("A").replace("Take notes", "Take short notes")), signal));
  assert.deepEqual([again.status, again.replaced], [201, a.pkg.origin.sha]);
  assert.deepEqual([await shaIn(A), await shaIn(null)], [again.pkg.origin.sha, none.pkg.origin.sha]);

  // A start loads each row into its own workspace; an upload the store no longer keeps is no longer served there alone.
  const fresh = new TemplateRegistry([]);
  await loadImported({ registry: fresh, store }, (id, why) => assert.fail(`${id}: ${why}`));
  assert.deepEqual([inWorkspace(A, () => fresh.get(ID))?.origin.sha, fresh.get(ID)?.origin.sha, inWorkspace(B, () => fresh.get(ID))], [again.pkg.origin.sha, none.pkg.origin.sha, undefined]);
  assert.equal(await store.importedTemplates.remove(ID), true, "the row of no workspace");
  await dropRemovedUploads({ registry: fresh, store });
  assert.deepEqual([inWorkspace(A, () => fresh.get(ID))?.origin.sha, fresh.get(ID)], [again.pkg.origin.sha, undefined]);
});

test("two workspaces importing one new package name at once both keep their own", { timeout: 60_000 }, async (t) => {
  const { store, registry, deps, signal } = await importsOn(t);
  // A's import is held after its check, before its write, while B's runs whole.
  let reached, release;
  const atWrite = new Promise((resolve) => (reached = resolve));
  const held = new Promise((resolve) => (release = resolve));
  const rows = store.importedTemplates;
  const racing = { ...deps, store: { ...deps.store, importedTemplates: { ...rows, put: async (row, workspace) => {
    if (workspace === A) (reached(), await held);
    return rows.put(row, workspace);
  } } } };
  const first = inWorkspace(A, () => importTemplate(racing, upload(notes("A")), signal));
  await atWrite;
  const second = await inWorkspace(B, () => importTemplate(racing, upload(notes("B")), signal));
  release();
  const done = await first;
  assert.deepEqual([done.status, second.status], [201, 201]);
  assert.deepEqual(inWorkspace(A, () => registry.get(ID))?.origin.sha, done.pkg.origin.sha);
  assert.deepEqual(inWorkspace(B, () => registry.get(ID))?.origin.sha, second.pkg.origin.sha);
  assert.equal((await rows.keys()).length, 2);
});

test("an agent's purge takes the upload it was applied from in its own workspace alone; another workspace's agent of that name keeps its own", { timeout: 60_000 }, async (t) => {
  const { store } = await storeOn(t);
  for (const [workspace, sha] of [[A, "a"], [B, "b"]]) {
    await store.importedTemplates.put({ id: ID, source: ID, sha: sha.repeat(64), publisher: "", files: {} }, workspace);
    await store.agents.create({ id: `agent-${sha}`, name: `agent-${sha}`, workspace }, { id: `rev-${sha}`, kind: "agentic", body: { instructions: "Answer." }, package: { id: ID, version: "1.0.0", sha: sha.repeat(64) } });
  }
  await store.agents.archive("agent-a", true);
  assert.equal(await store.agents.purge("agent-a"), true);
  assert.deepEqual((await store.importedTemplates.keys()).map((key) => key.workspace), [B], "B's upload, which B's agent was applied from, stays");
  await store.agents.archive("agent-b", true);
  assert.equal(await store.agents.purge("agent-b"), true);
  assert.deepEqual(await store.importedTemplates.keys(), []);
});

test("a server with no workspaces keeps its uploads as before: one package a name, a reimport replaces it, a delete removes it", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { runner: false });
  const own = (method, to, body) => send(server, undefined, method, to, body, server.token);
  const first = await own("POST", "/v2/templates/import", upload(notes("the owner")));
  assert.deepEqual([first.status, first.body.replaced], [201, null], first.text);
  const again = await own("POST", "/v2/templates/import", upload(notes("the owner").replace("Take notes", "Take short notes")));
  assert.deepEqual([again.status, again.body.replaced], [201, first.body.template.sha], again.text);
  assert.deepEqual((await own("GET", "/v2/templates")).body.templates.filter((one) => one.id === ID).map((one) => one.sha), [again.body.template.sha]);
  assert.equal((await own("GET", path)).body.template.sha, again.body.template.sha);
  assert.deepEqual((await server.store.importedTemplates.keys()), [{ id: ID, workspace: null }]);
  assert.equal((await own("DELETE", path)).status, 204);
  assert.equal((await own("GET", path)).status, 404);
  assert.deepEqual(await server.store.importedTemplates.keys(), []);
});

test("Postgres migration 0035 keys each imported package in the workspace it had: rows from before it land in their workspace, and the name is each workspace's after", postgresOnly("the Postgres migration"), async (t) => {
  const schema = await freshSchema();
  const sql = await client(schema);
  t.after(async () => {
    await sql.end();
    await dropSchema(schema);
  });
  await migrate(sql, schema, Date.now(), migrationsIn().filter((m) => m.version < 35));
  const put = (id, sha, workspace) => sql.query("INSERT INTO imported_templates (id, source, sha, publisher, files, imported_at, workspace) VALUES ($1, $1, $2, '', '{}', 1, $3)", [id, sha.repeat(64), workspace]);
  await put(ID, "a", A);
  await put("upload:plans", "b", null);
  await put("github:acme/notes", "c", B);
  const step = migrationsIn().find((m) => m.version === 35);
  assert.equal(step.breaking, true, "it drops the key on the id alone, which a server of the build before names in its writes");
  await migrate(sql, schema, Date.now());
  const store = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => store.close());
  assert.equal((await store.schemaState()).version, 35);
  const rows = async () => (await store.importedTemplates.list()).map((row) => [row.workspace, row.id, row.sha[0]]).sort((x, y) => `${x}`.localeCompare(`${y}`));
  assert.deepEqual(await rows(), [[A, ID, "a"], [B, "github:acme/notes", "c"], [null, "upload:plans", "b"]].sort((x, y) => `${x}`.localeCompare(`${y}`)));
  assert.deepEqual(await store.importedTemplates.stamp(ID, A), { sha: "a".repeat(64), importedAt: 1 }, "A's row, in A");
  assert.equal(await store.importedTemplates.stamp(ID), undefined, "in no workspace, none");
  // Each name is its workspace's now: B and no workspace each take A's, and each a second time replaces its own.
  await store.importedTemplates.put({ id: ID, source: ID, sha: "d".repeat(64), publisher: "", files: {} }, B);
  await store.importedTemplates.put({ id: ID, source: ID, sha: "e".repeat(64), publisher: "", files: {} });
  await store.importedTemplates.put({ id: ID, source: ID, sha: "f".repeat(64), publisher: "", files: {} });
  await store.importedTemplates.put({ id: "upload:plans", source: "upload:plans", sha: "g".repeat(64), publisher: "", files: {} });
  assert.deepEqual(await rows(), [[A, ID, "a"], [B, ID, "d"], [B, "github:acme/notes", "c"], [null, ID, "f"], [null, "upload:plans", "g"]].sort((x, y) => `${x}`.localeCompare(`${y}`)));
  // Two rows of one name in no workspace stay refused, as two in one workspace.
  await assert.rejects(sql.query("INSERT INTO imported_templates (id, source, sha, publisher, files, imported_at) VALUES ($1, $1, $2, '', '{}', 2)", [ID, "h".repeat(64)]), /duplicate key/);
  await assert.rejects(sql.query("INSERT INTO imported_templates (id, source, sha, publisher, files, imported_at, workspace) VALUES ($1, $1, $2, '', '{}', 2, $3)", [ID, "h".repeat(64), A]), /duplicate key/);
});

test("SQLite version 19 keys each imported package in the workspace it had: a server's open brings a store of 18 up, its rows each in their workspace", sqliteOnly("the SQLite store's upgrade"), async (t) => {
  const file = join(await scratch(t), "store.sqlite");
  await (await openSqliteStore({ file })).close();
  // A store of version 18: imported_templates keyed by its id alone, three rows in it.
  const raw = new DatabaseSync(file);
  raw.exec(`DROP TABLE imported_templates;
    CREATE TABLE imported_templates (id TEXT PRIMARY KEY, source TEXT NOT NULL, sha TEXT NOT NULL, publisher TEXT NOT NULL, files TEXT NOT NULL CHECK (json_valid(files)), imported_at INTEGER NOT NULL, workspace TEXT) STRICT;
    UPDATE store_meta SET schema_version = 18 WHERE singleton = 1;`);
  const put = raw.prepare("INSERT INTO imported_templates (id, source, sha, publisher, files, imported_at, workspace) VALUES (?, ?, ?, '', '{}', 1, ?)");
  put.run(ID, ID, "a".repeat(64), A);
  put.run("upload:plans", "upload:plans", "b".repeat(64), null);
  raw.close();
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error.name === "StoreAwaitsServer", "a runner waits for the server's upgrade");
  const store = await openSqliteStore({ file });
  t.after(() => store.close());
  assert.equal((await store.schemaState()).version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 19);
  assert.deepEqual((await store.importedTemplates.list()).map((row) => [row.workspace, row.id, row.sha[0]]), [[A, ID, "a"], [null, "upload:plans", "b"]]);
  await store.importedTemplates.put({ id: ID, source: ID, sha: "c".repeat(64), publisher: "", files: {} }, B);
  await store.importedTemplates.put({ id: ID, source: ID, sha: "d".repeat(64), publisher: "", files: {} });
  assert.deepEqual((await store.importedTemplates.keys()).map((key) => `${key.workspace}|${key.id}`).sort(), [`${A}|${ID}`, `${B}|${ID}`, `null|${ID}`, "null|upload:plans"]);
  assert.equal((await store.importedTemplates.stamp(ID, A)).sha, "a".repeat(64), "A's row as it was");
});
