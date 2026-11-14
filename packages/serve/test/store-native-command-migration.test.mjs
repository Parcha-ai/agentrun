// The released MCP pin migration and the native connector's additive migration must both survive a deploy.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate, migrationsIn, openPostgresStore, openSqliteStore } from "../dist/store/index.js";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const ONLY = postgresOnly("native command migration lineage");
const commandKey = "native.remote.command.preserved";
const payload = '{"connector_id":"cho\\u0073en","payload":"before\\u0000after"}';
const body = '{"instructions":"Preserve this existing agent."}';
const pin = { docs: { url: "https://docs.example/mcp", tools: [{ name: "search", inputSchema: { type: "object" } }] } };

test("a same-version SQLite store missing both metadata columns is upgraded only by the server, preserving existing records", async t => {
  const directory = await mkdtemp(join(tmpdir(), "native-mcp-upgrade-")), file = join(directory, "store.sqlite");
  let store, runner;
  t.after(async () => {
    try { await runner?.close(); }
    finally { try { await store?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  store = await openSqliteStore({ file });
  await store.agents.create({ id: "agent", name: "Existing agent" }, { id: "revision", kind: "agentic", body: JSON.parse(body) });
  await store.close(); store = undefined;
  let db = new DatabaseSync(file);
  db.exec("DROP INDEX settings_native_commands; ALTER TABLE settings DROP COLUMN connector_id; ALTER TABLE revisions DROP COLUMN mcp_pin");
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,456)").run(commandKey, payload);
  const before = { settings: db.prepare("SELECT key,value,updated_at FROM settings ORDER BY key").all(), revisions: db.prepare("SELECT * FROM revisions ORDER BY id").all() };
  db.close();
  await assert.rejects(openSqliteStore({ file, role: "runner" }), /Start the AgentRun server to install MCP revision metadata/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare("PRAGMA table_info(revisions)").all().some(row => row.name === "mcp_pin"), false);
  assert.equal(db.prepare("PRAGMA table_info(settings)").all().some(row => row.name === "connector_id"), false);
  db.close();
  store = await openSqliteStore({ file });
  runner = await openSqliteStore({ file, role: "runner" });
  assert.deepEqual((await runner.agents.revision("revision")).body, JSON.parse(body));
  assert.equal((await runner.agents.revision("revision")).mcpPin, null);
  assert.deepEqual((await runner.settings.all({ prefix: "native.remote.command.", connectorId: "chosen" })).map(row => row.value), [JSON.parse(payload)]);
  db = new DatabaseSync(file);
  try {
    assert.deepEqual(db.prepare("SELECT key,value,updated_at FROM settings ORDER BY key").all(), before.settings);
    const rows = db.prepare("SELECT * FROM revisions ORDER BY id").all().map(({ mcp_pin, ...row }) => Object.assign(Object.create(null), row));
    assert.deepEqual(rows, before.revisions);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='settings_native_commands'").get().n, 1);
  } finally { db.close(); }
});

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
  return { sql, open: async () => (store = await openPostgresStore({ url: PG_URL, schema })) };
}

for (const version of [10, 11]) {
  test(`a released PostgreSQL v${version} store upgrades with both revision pins and native command ownership intact`, ONLY, async t => {
    const migrations = migrationsIn();
    const { sql, open } = await fixture(t, migrations.slice(0, version));
    if (version === 11) await sql.query("UPDATE revisions SET mcp_pin=$1", [JSON.stringify(pin)]);
    const history = (await sql.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
    const store = await open();
    assert.deepEqual((await sql.query("SELECT * FROM schema_migrations WHERE version <= $1 ORDER BY version", [version])).rows, history, "applied migration text, names and timestamps are unchanged");
    assert.deepEqual((await sql.query("SELECT version,name FROM schema_migrations WHERE version >= 11 ORDER BY version")).rows, [
      { version: 11, name: "revision_mcp_pin" }, { version: 12, name: "native_command_owner" },
    ]);
    assert.deepEqual((await sql.query("SELECT body,mcp_pin,created_at FROM revisions WHERE id='revision'")).rows, [
      { body, mcp_pin: version === 11 ? JSON.stringify(pin) : null, created_at: 123 },
    ]);
    const revision = await store.agents.revision("revision");
    assert.deepEqual(revision.body, JSON.parse(body));
    assert.deepEqual(revision.mcpPin, version === 11 ? pin : null, "the ordinary revision reader sees the preserved pin");
    assert.deepEqual((await sql.query("SELECT value,updated_at,connector_id FROM settings WHERE key=$1", [commandKey])).rows, [
      { value: payload, updated_at: 456, connector_id: "chosen" },
    ]);
    assert.deepEqual((await store.settings.all({ prefix: "native.remote.command.", connectorId: "chosen" })).map(row => row.value), [JSON.parse(payload)]);
    assert.equal((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version, 12);
  });
}

// Exact SQL from the unpublished native-connector branch before released main used version 11. This is historical
// fixture data, never a migration to install or a history repair to run against an existing deployment.
const oldNativeSql = `-- A bounded connector owner is derived from the exact command JSON by the server, preserving payload bytes (including
-- escaped NUL, which PostgreSQL JSON extraction cannot read). Existing rows are backfilled before polling is served.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS connector_id TEXT COLLATE "C";
CREATE INDEX IF NOT EXISTS settings_native_commands ON settings (connector_id, key)
  WHERE key >= 'native.remote.command.' AND key < 'native.remote.command/';
UPDATE store_meta SET schema_version = 11 WHERE singleton = 1;
`;

test("an unpublished native-v11 PostgreSQL lineage refuses the released v11 migration without rewriting history or data", ONLY, async t => {
  const migrations = [...migrationsIn().slice(0, 10), {
    version: 11, name: "native_command_owner", sql: oldNativeSql,
    sha256: createHash("sha256").update(oldNativeSql).digest("hex"),
  }];
  const { sql, open } = await fixture(t, migrations);
  const before = {
    history: (await sql.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    settings: (await sql.query("SELECT * FROM settings ORDER BY key")).rows,
    agents: (await sql.query("SELECT * FROM agents ORDER BY id")).rows,
    revisions: (await sql.query("SELECT * FROM revisions ORDER BY id")).rows,
  };
  await assert.rejects(open(), /0011_revision_mcp_pin\.sql with other text.*an applied migration is never edited/);
  assert.deepEqual((await sql.query("SELECT * FROM schema_migrations ORDER BY version")).rows, before.history);
  assert.deepEqual((await sql.query("SELECT * FROM settings ORDER BY key")).rows, before.settings);
  assert.deepEqual((await sql.query("SELECT * FROM agents ORDER BY id")).rows, before.agents);
  assert.deepEqual((await sql.query("SELECT * FROM revisions ORDER BY id")).rows, before.revisions);
  assert.equal((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version, 11);
  assert.equal((await sql.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='revisions' AND column_name='mcp_pin'")).rows[0].n, 0, "no partial schema upgrade");
});
