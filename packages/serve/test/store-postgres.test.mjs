// The store's Postgres adapter (store/postgres): what SQLite's adapter tests check of its file, worker and locks, for a
// schema on Postgres. Who opens it: the server applies the migrations and holds the owner lock (one server per schema); a
// runner sets nothing up and refuses a schema version it does not know, in the same words. The migrations are versioned
// files, applied once, never edited. A lock held past the busy wait is StoreBusy; a transaction past its deadline is
// StoreDeadline, and the calls after it go on. A runner whose clock is far from the database's says so. One opener picks
// the store from AGENTRUN_STORE_URL.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly, schemaOf } from "./store-target.mjs";

const { migrate, migrationsIn, openPostgresStore, postgresWhere, openStore, PgConnection, SchemaVersionUnknown, storeTarget, StoreBusy, StoreConstraint, StoreDeadline, StoreOwned } = await import("../dist/store/index.js");
const { RunnerRefused, startRunnerProcess } = await import("../dist/runner/main.js");

const ONLY = postgresOnly("the Postgres adapter");

/** A schema name of the test's own, dropped after it (nothing made in it yet). */
async function schemaFor(t) {
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  return schema;
}

async function sql(schema, text, ...params) {
  const c = await client(schema);
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

test("a Postgres store's place names its host, database and schema, never the URL's user, password or query", () => {
  // A URL with a user and a password in it, set on the parsed URL (no credential in this file's text).
  const url = new URL("postgresql://db.example:6543/grep?sslmode=require&application_name=x");
  url.username = "someone";
  url.password = "x".repeat(12);
  const where = postgresWhere(url.href, "agentrun");
  assert.equal(where, "postgres:db.example:6543/grep/agentrun");
  assert.ok(!where.includes("someone") && !where.includes("xxxx") && !where.includes("sslmode"), where);
  assert.equal(postgresWhere("postgres://127.0.0.1/agentrun", "t_1"), "postgres:127.0.0.1/agentrun/t_1");
});

test("a Postgres store's where is its place: the server and a runner on one schema share it, another schema's differs", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  const runner = await openPostgresStore({ url: PG_URL, schema, role: "runner" });
  t.after(() => runner.close());
  assert.equal(server.where, postgresWhere(PG_URL, schema));
  assert.equal(runner.where, server.where, "one data, one where");
  const other = await schemaFor(t);
  const elsewhere = await openPostgresStore({ url: PG_URL, schema: other });
  t.after(() => elsewhere.close());
  assert.notEqual(elsewhere.where, server.where);
});

test("a server whose owner lock's connection is lost refuses every call from then (StoreOwned), and another server takes the schema", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  await server.agents.put({ id: "agent-1", name: "Agent" });
  // The owner lock's connection ended from outside (the database restarted it, an operator killed it): the lock is gone.
  // Found by the lock it holds: the advisory lock (hashtext(schema), hashtext('owner')).
  const killed = await sql(schema, `SELECT pg_terminate_backend(pid) AS gone FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2
    AND classid::bigint = (hashtext($1)::bigint & 4294967295) AND objid::bigint = (hashtext('owner')::bigint & 4294967295)`, schema);
  assert.deepEqual(killed.map((row) => row.gone), [true], "the owner lock's one connection ended");
  // The store hears of it when the connection's end reaches it: each try before that is a write that still lands. Bounded by
  // its own clock, never a sleep: a store that never hears of it fails here.
  const deadline = Date.now() + 10_000;
  let refused;
  while (!refused && Date.now() < deadline) {
    refused = await server.agents.put({ id: "agent-1", name: "Agent" }).then(() => undefined, (error) => error);
    if (!refused) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(refused instanceof StoreOwned, `the next write is refused: ${refused}`);
  await assert.rejects(server.agents.get("agent-1"), StoreOwned, "and so is a read");
  const next = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => next.close());
  assert.equal((await next.agents.get("agent-1"))?.name, "Agent", "another server holds the schema now");
});

test("a duplicate write on a store with a pool of one client is StoreConstraint naming its unique key, never a wait for a second client", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const store = await openPostgresStore({ url: PG_URL, schema, poolSize: 1 });
  t.after(() => store.close());
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  const error = await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-2", kind: "agentic", body: { instructions: "Answer." } }).then(() => null, (e) => e);
  assert.ok(error instanceof StoreConstraint, `refused as a constraint, not a deadline: ${error}`);
  assert.deepEqual(error.unique, { table: "agents", columns: ["id"] }, "naming its key");
  assert.equal((await store.agents.get("agent-1"))?.name, "Agent", "and the store's one client is free again");
});

test("a second server on the same schema is refused (StoreOwned); once the first closes, a server opens it", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const first = await openPostgresStore({ url: PG_URL, schema, role: "server" });
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, role: "server" }), (error) => error instanceof StoreOwned && /another server holds the store in the Postgres schema/.test(error.message));
  const runner = await openPostgresStore({ url: PG_URL, schema, role: "runner" });
  await runner.close();
  await first.close();
  const second = await openPostgresStore({ url: PG_URL, schema, role: "server" });
  await second.close();
});

test("servers of two schemas in one database hold their own owner locks", ONLY, async (t) => {
  const [a, b] = [await schemaFor(t), await schemaFor(t)];
  const one = await openPostgresStore({ url: PG_URL, schema: a });
  const two = await openPostgresStore({ url: PG_URL, schema: b });
  await two.close();
  await one.close();
});

test("a runner refuses a schema not set up yet, and one of a version it does not know (SchemaVersionUnknown); so does a server", ONLY, async (t) => {
  const schema = await schemaFor(t);
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, role: "runner" }), (error) => error instanceof SchemaVersionUnknown && error.found === null && error.message.includes(`the Postgres schema ${schema}`));
  const server = await openPostgresStore({ url: PG_URL, schema });
  await server.close();
  // A later build's migration, applied: one past this build's last.
  const known = migrationsIn().at(-1).version;
  await sql(schema, "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES ($1, 'later', 'x', 0)", known + 1);
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, role: "runner" }), (error) => error instanceof SchemaVersionUnknown && error.found === known + 1 && error.known === known);
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, role: "server" }), SchemaVersionUnknown, "nor does the server open a later build's schema");
});

test("a runner sets nothing up: its open of a schema not set up leaves no schema behind", ONLY, async (t) => {
  const schema = await schemaFor(t);
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, role: "runner" }), SchemaVersionUnknown);
  assert.deepEqual(await sql(undefined, "SELECT nspname FROM pg_namespace WHERE nspname = $1", schema), [], "no schema made");
});

test("the server applies each migration once, in one transaction, recording its version, name and file hash", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const migrations = migrationsIn();
  // Numbered 1, 2, 3 … from the initial schema, each file once.
  assert.deepEqual(migrations.map((m) => m.version), migrations.map((_, index) => index + 1));
  assert.equal(migrations[0].name, "initial");
  const first = await openPostgresStore({ url: PG_URL, schema });
  await first.close();
  const second = await openPostgresStore({ url: PG_URL, schema });
  await second.close();
  const rows = await sql(schema, "SELECT version, name, sha256 FROM schema_migrations ORDER BY version");
  assert.deepEqual(rows.map((row) => [Number(row.version), row.name, row.sha256]), migrations.map((m) => [m.version, m.name, m.sha256]), "each applied once");
});

test("a migration that fails leaves nothing of it: the schema's version is unchanged and its tables absent", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const connection = await PgConnection.open({ url: PG_URL, schema });
  t.after(() => connection.close());
  const shipped = migrationsIn();
  const broken = [...shipped, { version: shipped.length + 1, name: "broken", sql: "CREATE TABLE half_made (id BIGINT); SELECT no_such_function()", sha256: "y" }];
  await assert.rejects(connection.withClient((c) => migrate(c, schema, 0, broken)));
  assert.deepEqual(await sql(undefined, "SELECT nspname FROM pg_namespace WHERE nspname = $1", schema), [], "the first open's transaction rolled back whole, its schema too");
  await connection.withClient((c) => migrate(c, schema, 0));
  await assert.rejects(connection.withClient((c) => migrate(c, schema, 0, broken)));
  const rows = await sql(schema, "SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(rows.map((row) => Number(row.version)), shipped.map((m) => m.version), "the broken version not recorded");
  assert.deepEqual(await sql(schema, "SELECT to_regclass('half_made') AS t"), [{ t: null }], "its table not made");
});

test("an applied migration whose file changed since is refused at the server's open, naming the file", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const store = await openPostgresStore({ url: PG_URL, schema });
  await store.close();
  await sql(schema, "UPDATE schema_migrations SET sha256 = 'edited' WHERE version = 1");
  await assert.rejects(openPostgresStore({ url: PG_URL, schema }), /0001_initial\.sql with other text than this build's/);
});

test("a schema name that is not a plain lower-case name is refused before anything is opened", ONLY, async () => {
  for (const schema of ["Agentrun", "a-b", "x; DROP TABLE runs", "", "1abc"]) {
    await assert.rejects(openPostgresStore({ url: PG_URL, schema }), TypeError, schema);
  }
});

test("a write that waits for another writer's lock past the busy wait is StoreBusy, and writes nothing", ONLY, async (t) => {
  const { store, file, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const busy = await openPostgresStore({ url: PG_URL, schema: schemaOf(file), role: "runner", testClock: () => clock.now, busyTimeoutMs: 50 });
  t.after(() => busy.close());
  const other = await client(schemaOf(file));
  t.after(() => other.end().catch(() => undefined));
  await other.query("BEGIN");
  await other.query("SELECT 1 FROM runs WHERE id = 'run-1' FOR UPDATE");
  await assert.rejects(busy.runs.update(claim, { summary: "late" }), StoreBusy);
  await other.query("ROLLBACK");
  assert.equal((await store.runs.get("run-1")).summary, null, "nothing written");
});

test("a transaction past its deadline is rolled back with StoreDeadline, and the calls after it go on", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const connection = await PgConnection.open({ url: PG_URL, schema });
  t.after(() => connection.close());
  await connection.withClient((c) => migrate(c, schema, 0));
  const slow = connection.transaction(async (tx) => {
    await tx.run("INSERT INTO settings (key, value, updated_at) VALUES ('slow', '1', 1)");
    await tx.run("SELECT pg_sleep(30)");
  }, { deadlineMs: 200 });
  await assert.rejects(slow, StoreDeadline);
  assert.equal(await connection.get("SELECT 1 AS found FROM settings WHERE key = 'slow'"), undefined, "nothing of it kept");
  await connection.write([{ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('after', '1', 1)" }]);
  assert.deepEqual(await connection.get("SELECT key FROM settings WHERE key = 'after'"), { key: "after" }, "a write after it lands");
});

test("a runner whose clock is more than 2 s from the database's says so at its open; one in step says nothing", ONLY, async (t) => {
  const { file } = await storeOn(t);
  const said = [];
  const ahead = await openPostgresStore({ url: PG_URL, schema: schemaOf(file), role: "runner", now: () => Date.now() + 60_000, warn: (message) => said.push(message) });
  await ahead.close();
  assert.equal(said.length, 1);
  assert.match(said[0], /this runner's clock is \d+(\.\d)? s ahead of the store's database/);
  const inStep = await openPostgresStore({ url: PG_URL, schema: schemaOf(file), role: "runner", warn: (message) => said.push(message) });
  await inStep.close();
  assert.equal(said.length, 1, "nothing more said");
});

test("the one opener picks Postgres for a postgres:// AGENTRUN_STORE_URL, in AGENTRUN_STORE_SCHEMA, else SQLite in the data directory", ONLY, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-open-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(storeTarget(dir, {}, ""), { kind: "sqlite", dataDir: dir });
  assert.deepEqual(storeTarget(dir, {}, "postgresql://h/db"), { kind: "postgres", url: "postgresql://h/db", schema: "agentrun" });
  assert.deepEqual(storeTarget(dir, { AGENTRUN_STORE_SCHEMA: "other" }, "postgresql://h/db"), { kind: "postgres", url: "postgresql://h/db", schema: "other" });
  // The URL is a secret, read by name (secrets.ts secret), never from an environment handed in.
  assert.deepEqual(storeTarget(dir, { AGENTRUN_STORE_URL: "postgresql://h/db" }, ""), { kind: "sqlite", dataDir: dir });
  assert.throws(() => storeTarget(dir, {}, "mysql://h/db"), TypeError);
  const schema = await schemaFor(t);
  const store = await openStore({ dataDir: dir, url: PG_URL, env: { AGENTRUN_STORE_SCHEMA: schema } });
  await queued(store);
  await store.close();
  assert.equal((await sql(schema, "SELECT id FROM runs")).length, 1, "the run is in the Postgres schema");
});

test("a runner process on a schema not set up is refused in the SQLite words, naming the schema and never the URL", ONLY, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const schema = await schemaFor(t);
  const env = { AGENTRUN_STORE_SCHEMA: schema };
  const error = await startRunnerProcess({ dataDir: dir, env, storeUrl: PG_URL, createLoop: () => assert.fail("no run is claimed") }).then(() => null, (e) => e);
  assert.ok(error instanceof RunnerRefused, String(error));
  assert.equal(error.message, `The store in the Postgres schema ${schema} is not set up yet: start the server on the Postgres schema ${schema} first, then the runner.`);
  assert.ok(!error.message.includes(PG_URL), "the URL is not in the words");
});
