// A trigger's package mark (triggers.template_id): the id of the template package whose apply made or last kept the
// trigger, null for one a person made (or one made before the mark was kept). A template update removes only triggers
// marked with its own package. It is written by the store's create and update alone (no API body names it), and an update
// or removal can be made conditional on the trigger's agent (`ifAgent`), compared in the same statement: a trigger moved to
// another agent meanwhile is neither changed nor removed. On SQLite a store an earlier build of this version made gets the
// column at the server's open (the version kept); on Postgres, migration trigger_template adds it where it is missing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../dist/store/schema.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";

/** A schedule trigger of `agentId`'s, as the engine hands one to the store. */
const trigger = (id, agentId = "agent-1", extra = {}) => ({
  id, agentId, name: id, enabled: true, source: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }, target: { kind: "start_run", agent_id: agentId, input: { content: "Go." } }, nextAt: null, catchupWindowS: 3600, ...extra,
});

test("a trigger keeps the package mark it was made with; one made without reads null; an update sets it, clears it, or leaves it as it was", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  assert.equal((await store.triggers.create(trigger("marked", "agent-1", { templateId: "local:digest" }))).templateId, "local:digest");
  assert.equal((await store.triggers.get("marked")).templateId, "local:digest", "read back");
  assert.equal((await store.triggers.create(trigger("plain"))).templateId, null, "a trigger made with no mark reads null");
  assert.equal((await store.triggers.update("plain", { templateId: "local:digest" })).templateId, "local:digest", "an update marks it");
  assert.equal((await store.triggers.update("plain", { enabled: false })).templateId, "local:digest", "one that leaves the mark out keeps it");
  assert.equal((await store.triggers.update("plain", { templateId: null })).templateId, null, "and one clears it");
  assert.deepEqual((await store.triggers.list("agent-1")).map((row) => [row.id, row.templateId]), [["marked", "local:digest"], ["plain", null]]);
});

test("an update or a removal made on the agent's condition (ifAgent) writes nothing to a trigger another agent has now; on its own agent it writes", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "agent-1", "rev-1");
  await agentWithRevision(store, "agent-2", "rev-2");
  await store.triggers.create(trigger("moved", "agent-1", { templateId: "local:digest" }));
  // Moved to agent-2 (a PATCH of its target), the mark cleared in that write.
  await store.triggers.update("moved", { agentId: "agent-2", target: trigger("moved", "agent-2").target, templateId: null });
  assert.equal(await store.triggers.update("moved", { name: "taken back", templateId: "local:digest" }, undefined, { ifAgent: "agent-1" }), undefined, "an update on agent-1's condition finds no such trigger");
  const kept = await store.triggers.get("moved");
  assert.deepEqual([kept.agentId, kept.name, kept.templateId], ["agent-2", "moved", null], "nothing written");
  assert.equal(await store.triggers.remove("moved", { ifAgent: "agent-1" }), false, "a removal on agent-1's condition removes nothing");
  assert.ok(await store.triggers.get("moved"), "the trigger is there");
  assert.equal((await store.triggers.update("moved", { name: "renamed" }, undefined, { ifAgent: "agent-2" })).name, "renamed", "on its own agent's condition the update writes");
  assert.equal(await store.triggers.remove("moved", { ifAgent: "agent-2" }), true, "and the removal removes it");
  assert.equal(await store.triggers.get("moved"), undefined);
  assert.equal(await store.triggers.remove("moved"), false, "a removal of no trigger removes nothing");
});

test("a store an earlier build of this version made (no triggers.template_id) opens at its version: a runner refuses it until the server adds the column, its triggers reading no mark", sqliteOnly("an earlier build's store file"), async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const store = await openSqliteStore({ file, role: "server", now: () => T0 });
  await agentWithRevision(store);
  await store.triggers.create(trigger("old", "agent-1", { templateId: "local:digest" }));
  await store.close();
  // The store as the build before the mark made it: the same version, its triggers table with no template_id column.
  const db = new DatabaseSync(file);
  try {
    db.exec("ALTER TABLE triggers DROP COLUMN template_id");
  } finally {
    db.close();
  }
  const columnOf = () => {
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      const column = check.prepare("SELECT name, type, \"notnull\" FROM pragma_table_info('triggers') WHERE name = 'template_id'").get();
      return { column: column && { ...column }, version: check.prepare("SELECT schema_version FROM store_meta").get().schema_version };
    } finally {
      check.close();
    }
  };
  await assert.rejects(openSqliteStore({ file, role: "runner" }), /Start the AgentRun server to add each trigger's package mark before opening a runner/);
  assert.deepEqual(columnOf(), { column: undefined, version: SCHEMA_VERSION }, "a runner adds nothing");
  const second = await openSqliteStore({ file, role: "server", now: () => T0 });
  try {
    assert.deepEqual(columnOf(), { column: { name: "template_id", type: "TEXT", notnull: 0 }, version: SCHEMA_VERSION }, "the server adds triggers.template_id, nullable, the version kept");
    assert.equal((await second.triggers.get("old")).templateId, null, "a trigger made before reads no mark");
    assert.equal((await second.triggers.create(trigger("new", "agent-1", { templateId: "local:digest" }))).templateId, "local:digest");
  } finally {
    await second.close();
  }
  const runner = await openSqliteStore({ file, role: "runner" });
  try {
    assert.equal((await runner.triggers.get("new")).templateId, "local:digest", "a runner opens it once the server has");
  } finally {
    await runner.close();
  }
});

test("migration trigger_template adds triggers.template_id where it is missing: a schema a build before it left keeps its triggers, each reading no mark", postgresOnly("the Postgres migrations"), async (t) => {
  const { migrationsIn, openPostgresStore } = await import("../dist/store/index.js");
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const first = await openPostgresStore({ url: PG_URL, schema });
  await agentWithRevision(first);
  await first.triggers.create(trigger("old", "agent-1", { templateId: "local:digest" }));
  await first.close();
  const migrations = migrationsIn();
  const own = migrations.find((one) => one.name === "trigger_template");
  assert.ok(own, "a migration named trigger_template ships");
  // The schema as the build before it left it: the column gone, the migration (and any after it) unrecorded.
  const c = await client(schema);
  try {
    await c.query("ALTER TABLE triggers DROP COLUMN template_id");
    await c.query("DELETE FROM schema_migrations WHERE version >= $1", [own.version]);
    await c.query("UPDATE store_meta SET schema_version = $1 WHERE singleton = 1", [own.version - 1]);
  } finally {
    await c.end();
  }
  const second = await openPostgresStore({ url: PG_URL, schema });
  try {
    assert.equal((await second.triggers.get("old")).templateId, null, "a trigger made before reads no mark");
    assert.equal((await second.triggers.create(trigger("new", "agent-1", { templateId: "local:digest" }))).templateId, "local:digest");
  } finally {
    await second.close();
  }
  const check = await client(schema);
  try {
    const { rows } = await check.query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'triggers' AND column_name = 'template_id'", [schema]);
    assert.deepEqual(rows, [{ data_type: "text", is_nullable: "YES" }], "the column is text, nullable");
    const { rows: meta } = await check.query("SELECT schema_version FROM store_meta WHERE singleton = 1");
    assert.equal(Number(meta[0].schema_version), migrations.at(-1).version, "store_meta at the last migration's version");
  } finally {
    await check.end();
  }
});
