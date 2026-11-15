// Released revision pins and the native connector's additive ownership metadata survive one server-owned upgrade.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate, migrationsIn, openPostgresStore, openSqliteStore, SchemaVersionUnknown } from "../dist/store/index.js";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const ONLY = postgresOnly("native command migration lineage");
const commandKey = "native.remote.command.preserved";
const payload = '{"connector_id":"cho\\u0073en","payload":"before\\u0000after"}';
const body = '{"instructions":"Preserve this existing agent.","monid":{"legacy":{"description":"Historical body pin","input":{"type":"object"},"usd":null}}}';
const pin = { docs: { url: "https://docs.example/mcp", tools: [{ name: "search", inputSchema: { type: "object" } }] } };
const monidPin = { endpoint: { description: "Saved endpoint", input: { type: "object" }, usd: 0.125 } };

const missingMetadata = [[], ["mcp_pin"], ["monid_pin"], ["mcp_pin", "monid_pin"], ["connector_id"],
  ["mcp_pin", "connector_id"], ["monid_pin", "connector_id"], ["mcp_pin", "monid_pin", "connector_id"]];

for (const missing of missingMetadata) {
  test(`SQLite metadata ${missing.join("+") || "already prepared"}: only the server upgrades, preserving pins and raw payloads`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "native-pins-upgrade-")), file = join(directory, "store.sqlite");
    let store, runner;
    t.after(async () => {
      try { await runner?.close(); }
      finally { try { await store?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    });
    store = await openSqliteStore({ file });
    await store.agents.create({ id: "agent", name: "Existing agent" }, {
      id: "revision", kind: "agentic", body: JSON.parse(body), mcpPin: pin, monidPin,
    });
    await store.close(); store = undefined;
    let db = new DatabaseSync(file);
    if (missing.includes("connector_id")) db.exec("DROP INDEX settings_native_commands; ALTER TABLE settings DROP COLUMN connector_id");
    for (const column of ["mcp_pin", "monid_pin"]) if (missing.includes(column)) db.exec(`ALTER TABLE revisions DROP COLUMN ${column}`);
    db.prepare("UPDATE revisions SET body=? WHERE id='revision'").run(body);
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,456)").run(commandKey, payload);
    const snapshot = () => ({
      schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
      settings: db.prepare("SELECT * FROM settings ORDER BY key").all(),
      revisions: db.prepare("SELECT * FROM revisions ORDER BY id").all(),
      meta: db.prepare("SELECT * FROM store_meta").all(),
    });
    const before = snapshot(); db.close();
    if (missing.length) {
      const refusal = missing.some(column => column !== "connector_id") ? /Start the AgentRun server to install MCP and Monid revision metadata/ : /Native command ownership metadata is not prepared/;
      await assert.rejects(openSqliteStore({ file, role: "runner" }), refusal);
    } else {
      runner = await openSqliteStore({ file, role: "runner" });
      await runner.close(); runner = undefined;
    }
    db = new DatabaseSync(file);
    assert.deepEqual(snapshot(), before, "runner open or refusal performs no DDL, backfill or data change");
    db.close();
    store = await openSqliteStore({ file });
    runner = await openSqliteStore({ file, role: "runner" });
    const revision = await runner.agents.revision("revision");
    assert.deepEqual(revision.body, JSON.parse(body));
    assert.deepEqual(revision.mcpPin, missing.includes("mcp_pin") ? null : pin);
    assert.deepEqual(revision.monidPin, missing.includes("monid_pin") ? null : monidPin, "a new column never trusts a historical body pin");
    assert.deepEqual((await runner.settings.all({ prefix: "native.remote.command.", connectorId: "chosen" })).map(row => row.value), [JSON.parse(payload)]);
    db = new DatabaseSync(file);
    const after = snapshot();
    assert.deepEqual(db.prepare("SELECT key,value,updated_at FROM settings ORDER BY key").all(),
      before.settings.map(({ key, value, updated_at }) => Object.assign(Object.create(null), { key, value, updated_at })));
    const existingColumns = Object.keys(before.revisions[0]);
    assert.deepEqual(after.revisions.map(row => Object.assign(Object.create(null), Object.fromEntries(existingColumns.map(key => [key, row[key]])))), before.revisions);
    assert.equal(db.prepare("SELECT connector_id FROM settings WHERE key=?").get(commandKey).connector_id, "chosen");
    assert.equal(db.prepare("SELECT schema_version FROM store_meta").get().schema_version, 11);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='settings_native_commands'").get().n, 1);
    db.close();
    await runner.close(); runner = undefined;
    await store.close(); store = undefined;
    store = await openSqliteStore({ file });
    db = new DatabaseSync(file);
    try { assert.deepEqual(snapshot(), after, "a second server open is idempotent"); }
    finally { db.close(); }
  });
}

async function fixture(t, migrations) {
  const schema = await freshSchema(), sql = await client();
  let store;
  t.after(async () => {
    try { await store?.close(); }
    finally { try { await sql.end(); } finally { await dropSchema(schema); } }
  });
  await migrate(sql, schema, 123, migrations);
  await sql.query("SET search_path TO " + schema);
  await sql.query("INSERT INTO agents(id,name,current_revision,created_at) VALUES('agent','Existing agent','revision',123)");
  await sql.query("INSERT INTO revisions(id,agent_id,kind,body,created_at) VALUES('revision','agent','agentic',$1,123)", [body]);
  await sql.query("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,456)", [commandKey, payload]);
  return { sql, schema, open: async () => (store = await openPostgresStore({ url: PG_URL, schema })) };
}

for (const version of [10, 11, 12]) {
  test(`a released PostgreSQL v${version} store upgrades through v13 with MCP, Monid and native ownership intact`, ONLY, async t => {
    const migrations = migrationsIn();
    assert.deepEqual(migrations.map(m => m.version), Array.from({ length: 13 }, (_, i) => i + 1));
    const { sql, schema, open } = await fixture(t, migrations.slice(0, version));
    if (version >= 11) await sql.query("UPDATE revisions SET mcp_pin=$1", [JSON.stringify(pin)]);
    if (version >= 12) await sql.query("UPDATE revisions SET monid_pin=$1", [JSON.stringify(monidPin)]);
    const history = (await sql.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
    const before = (await sql.query("SELECT * FROM revisions ORDER BY id")).rows;
    await assert.rejects(openPostgresStore({ url: PG_URL, schema, role: "runner" }), SchemaVersionUnknown);
    assert.deepEqual((await sql.query("SELECT * FROM schema_migrations ORDER BY version")).rows, history);
    assert.deepEqual((await sql.query("SELECT * FROM revisions ORDER BY id")).rows, before);
    assert.equal((await sql.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='settings' AND column_name='connector_id'")).rows[0].n, 0, "runner refuses without native metadata DDL");
    const store = await open();
    assert.deepEqual((await sql.query("SELECT * FROM schema_migrations WHERE version <= $1 ORDER BY version", [version])).rows, history, "released migration text, names and timestamps remain exact");
    assert.deepEqual((await sql.query("SELECT version,name FROM schema_migrations WHERE version >= 11 ORDER BY version")).rows, [
      { version: 11, name: "revision_mcp_pin" }, { version: 12, name: "revision_monid_pin" }, { version: 13, name: "native_command_owner" },
    ]);
    assert.deepEqual((await sql.query("SELECT body,mcp_pin,monid_pin,created_at FROM revisions WHERE id='revision'")).rows, [
      { body, mcp_pin: version >= 11 ? JSON.stringify(pin) : null, monid_pin: version >= 12 ? JSON.stringify(monidPin) : null, created_at: 123 },
    ]);
    const revision = await store.agents.revision("revision");
    assert.deepEqual(revision.body, JSON.parse(body));
    assert.deepEqual(revision.mcpPin, version >= 11 ? pin : null);
    assert.deepEqual(revision.monidPin, version >= 12 ? monidPin : null);
    assert.deepEqual((await sql.query("SELECT value,updated_at,connector_id FROM settings WHERE key=$1", [commandKey])).rows, [
      { value: payload, updated_at: 456, connector_id: "chosen" },
    ]);
    assert.deepEqual((await store.settings.all({ prefix: "native.remote.command.", connectorId: "chosen" })).map(row => row.value), [JSON.parse(payload)]);
    assert.equal((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version, 13);
    const applied = (await sql.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
    await store.close();
    await open();
    assert.deepEqual((await sql.query("SELECT * FROM schema_migrations ORDER BY version")).rows, applied, "server reopen changes no applied history");
    assert.deepEqual((await sql.query("SELECT value,updated_at,connector_id FROM settings WHERE key=$1", [commandKey])).rows, [
      { value: payload, updated_at: 456, connector_id: "chosen" },
    ]);
  });
}

// Exact historical native-v11 SQL; v12 differed only in its recorded schema version. These are refusal fixtures,
// never migrations to install or history repairs to run against an existing deployment.
const oldNativeSql = `-- A bounded connector owner is derived from the exact command JSON by the server, preserving payload bytes (including
-- escaped NUL, which PostgreSQL JSON extraction cannot read). Existing rows are backfilled before polling is served.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS connector_id TEXT COLLATE "C";
CREATE INDEX IF NOT EXISTS settings_native_commands ON settings (connector_id, key)
  WHERE key >= 'native.remote.command.' AND key < 'native.remote.command/';
UPDATE store_meta SET schema_version = 11 WHERE singleton = 1;
`;

for (const version of [11, 12]) {
  test(`an unpublished native-v${version} PostgreSQL lineage refuses released history without changing data or schema`, ONLY, async t => {
    const sqlText = version === 11 ? oldNativeSql : oldNativeSql.replace("schema_version = 11", "schema_version = 12");
    const digest = createHash("sha256").update(sqlText).digest("hex");
    assert.equal(digest, version === 11 ? "aca434858b2e4d7ec4dfa260f1a66b5dca432c83c96c9eb25314154916a45dab" : "8315e5ba089c4e7ac51178e1572c152a880fc9d7c6671a6aff87d9810b94fa38");
    const migrations = [...migrationsIn().slice(0, version - 1), { version, name: "native_command_owner", sql: sqlText, sha256: digest }];
    const { sql, open } = await fixture(t, migrations);
    const snapshot = async () => ({
      history: (await sql.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
      settings: (await sql.query("SELECT * FROM settings ORDER BY key")).rows,
      agents: (await sql.query("SELECT * FROM agents ORDER BY id")).rows,
      revisions: (await sql.query("SELECT * FROM revisions ORDER BY id")).rows,
      meta: (await sql.query("SELECT * FROM store_meta")).rows,
      columns: (await sql.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position")).rows,
      indexes: (await sql.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() ORDER BY indexname")).rows,
    });
    const before = await snapshot();
    const released = version === 11 ? "0011_revision_mcp_pin" : "0012_revision_monid_pin";
    await assert.rejects(open(), new RegExp(released + "\\.sql with other text.*an applied migration is never edited"));
    assert.deepEqual(await snapshot(), before, "no lineage relabel, data reset, backfill or partial schema upgrade");
    assert.equal((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version, version);
    assert.equal((await sql.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='revisions' AND column_name='mcp_pin'")).rows[0].n, version === 11 ? 0 : 1);
    assert.equal((await sql.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='revisions' AND column_name='monid_pin'")).rows[0].n, 0);
  });
}
