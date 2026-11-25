// When a run or an agent was purged (runs.purged_at, agents.purged_at): SQLite version 13 comes to 14 at its server's
// open (schema.ts purgeUpgrade), never at a runner's, every row it kept read as not purged, then on to this version
// (15, diskUpgrade: each run's disk; 16, ledgerUpgrade: no ledger epoch); Postgres 0020 takes 0021 (migrations/0021_purged.sql) the same way.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";

const { migrate, migrationsIn, openPostgresStore, openSqliteStore, SCHEMA_VERSION } = await import("../dist/store/index.js");

const T = Date.parse("2026-11-19T09:00:00.000Z");

test("SQLite: a version 13 store comes to this version at its server's open, never at a runner's: its runs and agents read as not purged", sqliteOnly("the SQLite upgrade"), async (t) => {
  assert.equal(SCHEMA_VERSION, 16);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-purge-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  // Version 13's shape: this version's store with purged_at and runs.disk taken out, holding an agent and a run of it.
  const made = await openSqliteStore({ file });
  await made.agents.create({ id: "agent-old", name: "Old" }, { id: "rev-old", kind: "agentic", body: { instructions: "Answer." } });
  await made.runs.create({ id: "run-old", agentId: "agent-old", revisionId: "rev-old" }, { body: { input: { content: "What is six times seven?" } } });
  await made.close();
  const old = new DatabaseSync(file);
  try {
    for (const table of ["runs", "agents"]) old.exec(`ALTER TABLE ${table} DROP COLUMN purged_at`);
    old.exec("ALTER TABLE runs DROP COLUMN disk");
    old.exec("UPDATE store_meta SET schema_version = 13 WHERE singleton = 1");
  } finally {
    old.close();
  }
  const read = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const columns = (table) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name);
      return { version: db.prepare("SELECT schema_version FROM store_meta").get().schema_version, runs: columns("runs").includes("purged_at"), agents: columns("agents").includes("purged_at") };
    } finally {
      db.close();
    }
  };
  const before = read();
  assert.deepEqual(before, { version: 13, runs: false, agents: false });
  await assert.rejects(openSqliteStore({ file, role: "runner" }), /Start the AgentRun server to bring this store from version 13 to 16 before opening a runner/);
  assert.deepEqual(read(), before, "a runner's refusal changes nothing");
  const store = await openSqliteStore({ file });
  try {
    assert.deepEqual(read(), { version: 16, runs: true, agents: true });
    assert.equal((await store.runs.get("run-old"))?.disk, null, "its launch names no disk: the default disk's");
    assert.deepEqual([(await store.runs.get("run-old"))?.purgedAt, (await store.agents.get("agent-old"))?.purgedAt], [null, null], "the rows it kept are not purged");
    assert.deepEqual((await store.runs.list({ agentId: "agent-old" })).map((run) => run.id), ["run-old"], "and list as before");
  } finally {
    await store.close();
  }
  await (await openSqliteStore({ file })).close();
  assert.equal(read().version, 16, "a second open changes nothing");
  await (await openSqliteStore({ file, role: "runner" })).close();
});

test("Postgres: a store at 0020 takes 0021: its runs and agents read as not purged", postgresOnly("the Postgres migration"), async (t) => {
  const schema = await freshSchema();
  const sql = await client(schema);
  let store;
  t.after(async () => {
    try {
      await store?.close();
    } finally {
      await sql.end();
      await dropSchema(schema);
    }
  });
  const earlier = migrationsIn().filter((m) => m.version <= 20);
  assert.equal(earlier.at(-1).version, 20, "the earlier release's last migration");
  await migrate(sql, schema, T, earlier);
  await sql.query("INSERT INTO agents (id, name, description, current_revision, created_at) VALUES ($1, $2, $3, NULL, $4)", ["agent-old", "Old", "Kept.", T]);
  const purgedColumns = async () => (await sql.query("SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'purged_at' ORDER BY table_name", [schema])).rows.map((row) => row.table_name);
  assert.deepEqual(await purgedColumns(), [], "0020 keeps no purge time");
  store = await openPostgresStore({ url: PG_URL, schema });
  assert.ok(migrationsIn().some((m) => m.version === 21), "0021 ships");
  assert.equal(Number((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version), migrationsIn().at(-1).version);
  assert.deepEqual(await purgedColumns(), ["agents", "runs"]);
  assert.equal((await store.agents.get("agent-old"))?.purgedAt, null, "the agent it kept is not purged");
});
