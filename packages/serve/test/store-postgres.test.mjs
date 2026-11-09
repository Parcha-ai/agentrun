// The store's Postgres adapter (store/postgres): what SQLite's adapter tests check of its file, worker and locks, for a
// schema on Postgres. Who opens it: the server applies the migrations and holds the owner lock (one server per schema); a
// runner sets nothing up and refuses a schema version it does not know, in the same words. The migrations are versioned
// files, applied once, never edited. A lock held past the busy wait is StoreBusy; a transaction past its deadline is
// StoreDeadline, and the calls after it go on. A runner whose clock is far from the database's says so. One opener picks
// the store from AGENTRUN_STORE_URL.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";
import { queued, storeOn } from "./store-helpers.mjs";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly, schemaOf } from "./store-target.mjs";

const { migrate, migrationsIn, openPostgresStore, postgresVersionOf: versionOf, postgresWhere, openStore, PgConnection, SchemaVersionUnknown, storeTarget, StoreBusy, StoreConstraint, STORE_CONNECT_TIMEOUT_MS, StoreDeadline, StoreOwned } = await import("../dist/store/index.js");
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

/** A TCP server on loopback that takes every connection and never says a word (a database host that hangs), closed
 *  after the test. With `forward`, a connection is piped to the test Postgres instead while `forward.on` is true; set it
 *  false and every connection open is cut, and new ones hang. */
async function silentHost(t, forward) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (forward?.on) {
      const target = new URL(PG_URL);
      const upstream = connect(Number(target.port || 5432), target.hostname);
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return { port: server.address().port, cut: () => { for (const socket of sockets) socket.destroy(); } };
}

/** `promise`'s outcome, or "hung" past `ms` on this test's own timer: a call that never settles fails the test, bounded. */
const within = (promise, ms) => Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), new Promise((resolve) => setTimeout(() => resolve("hung"), ms).unref())]);

test("migrate and versionOf refuse a schema that is not a store schema name before sending any statement", async () => {
  const sent = [];
  const recorder = { query: async (sql) => (sent.push(sql), { rows: [] }) };
  for (const bad of ["agentrun; DROP TABLE x", "Agentrun", "a-b", ""]) {
    await assert.rejects(migrate(recorder, bad, 0), TypeError, `migrate: ${bad}`);
    await assert.rejects(versionOf(recorder, bad), TypeError, `versionOf: ${bad}`);
  }
  assert.deepEqual(sent, [], "no statement sent");
});

test("a store opened on a database host that takes the connection but never answers is refused within its connect deadline (StoreDeadline), naming the host, never the password", async (t) => {
  const host = await silentHost(t);
  const secret = "p".repeat(14);
  const url = `postgres://agentrun:${secret}@127.0.0.1:${host.port}/agentrun`;
  for (const role of ["server", "runner"]) {
    const outcome = await within(openPostgresStore({ url, schema: "agentrun", role, connectTimeoutMs: 300 }), 10_000);
    assert.notEqual(outcome, "hung", `${role}: the open hung past 10 s`);
    assert.ok(outcome.error instanceof StoreDeadline, `${role}: refused as a deadline: ${outcome.error ?? "opened"}`);
    assert.match(outcome.error.message, new RegExp(`127\\.0\\.0\\.1:${host.port}/agentrun`), `${role}: names the host`);
    assert.ok(!outcome.error.message.includes(secret), `${role}: never the password`);
  }
});

test("the store's default connect deadline is STORE_CONNECT_TIMEOUT_MS, 4 s: below the runner's 5 s stop margin", () => {
  assert.equal(STORE_CONNECT_TIMEOUT_MS, 4_000);
});

/** A runner store on `schema` with a claim of run-0, whose every pool client is then held: `size` reads of it each waiting
 *  on a table another session holds (a runner whose loops are all busy). Answers the store, the claims and `letGo()`. */
async function saturated(t, schema, { size, connectTimeoutMs }) {
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  await queued(server, "run-0");
  const runner = await openPostgresStore({ url: PG_URL, schema, role: "runner", poolSize: size, connectTimeoutMs });
  t.after(() => runner.close().catch(() => undefined));
  const claims = [await runner.claim("run-0", "runner-a", { leaseMs: 30_000 })];
  const holder = await client(schema);
  t.after(() => holder.end().catch(() => undefined));
  await holder.query("BEGIN");
  await holder.query("LOCK TABLE agents IN ACCESS EXCLUSIVE MODE");
  const busy = [];
  for (let i = 1; i <= size; i++) {
    const read = runner.agents.list();
    read.catch(() => undefined);
    busy.push(read);
  }
  // Every pool client held, proven as a caller meets it: a read of a table nobody locks gets no client within the connect
  // deadline (StoreDeadline). Until the busy reads have taken every client, such a read may still land; it is tried again.
  const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  let probe;
  for (let tries = 0; tries < 20; tries++) {
    probe = await runner.runs.get("run-0").then(() => undefined, (error) => error);
    if (probe instanceof StoreDeadline) break;
    await holder.query("SELECT $1::int", [holderPid]);
  }
  assert.ok(probe instanceof StoreDeadline, `the pool is full: a read of runs gets no client (${probe ?? "it got one"})`);
  return { runner, claims, letGo: async () => { await holder.query("ROLLBACK"); await Promise.allSettled(busy); } };
}

test("a runner whose every pool client is held by its loops still renews its claim in time, on the store's lease connection", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const { runner, claims, letGo } = await saturated(t, schema, { size: 2, connectTimeoutMs: 1_000 });
  const outcome = await within(runner.renewMany([claims[0]], { leaseMs: 30_000 }), 3_000);
  await letGo();
  assert.notEqual(outcome, "hung", "the renew hung");
  assert.ok(!outcome.error, `renewed, not refused: ${outcome.error}`);
  assert.equal(outcome.value[0]?.runId, "run-0", "the claim renewed");
});

test("a write on a store whose every pool client is held is refused at the connect deadline (StoreDeadline), never left waiting for one", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const { runner, letGo } = await saturated(t, schema, { size: 2, connectTimeoutMs: 500 });
  const outcome = await within(runner.agents.put({ id: "agent-x", name: "X" }), 3_000);
  await letGo();
  assert.notEqual(outcome, "hung", "the write hung");
  assert.ok(outcome.error instanceof StoreDeadline, `refused at the connect deadline: ${outcome.error ?? "written"}`);
});

test("a transaction whose deadline runs from its call counts the wait for a pool client against it: past it, StoreDeadline, never begun", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  const connection = await PgConnection.open({ url: PG_URL, schema, poolSize: 1, connectTimeoutMs: 10_000 });
  t.after(() => connection.close());
  // The pool's one client held by a transaction that waits on another session's lock.
  const holder = await client(schema);
  t.after(() => holder.end().catch(() => undefined));
  await holder.query("BEGIN");
  await holder.query("LOCK TABLE agents IN ACCESS EXCLUSIVE MODE");
  const held = connection.transaction((tx) => tx.get("SELECT count(*) AS n FROM agents"));
  held.catch(() => undefined);
  const outcome = await within(connection.transaction((tx) => tx.get("SELECT 1 AS one"), { deadlineMs: 300, fromCall: true }), 3_000);
  await holder.query("ROLLBACK");
  await held;
  assert.notEqual(outcome, "hung", "the transaction waited past its deadline");
  assert.ok(outcome.error instanceof StoreDeadline, `refused at its own deadline: ${outcome.error ?? "ran"}`);
  assert.equal(outcome.error.deadlineMs, 300);
});

test("a store's connection errors (a refused port, a wrong password, a host that never answers) carry no URL and no password, in their words or anything they hold", ONLY, async (t) => {
  const host = await silentHost(t);
  const secret = "w".repeat(16);
  const real = new URL(PG_URL);
  const urls = {
    refused: `postgres://agentrun:${secret}@127.0.0.1:1/agentrun`,
    "wrong password": `postgres://${real.username}:${secret}@${real.host}${real.pathname}`,
    silent: `postgres://agentrun:${secret}@127.0.0.1:${host.port}/agentrun`,
  };
  for (const [what, url] of Object.entries(urls)) {
    const error = await openPostgresStore({ url, schema: "agentrun", role: "runner", connectTimeoutMs: 500 }).then(() => null, (e) => e);
    assert.ok(error instanceof Error, `${what}: refused`);
    // What a log line could print: its message, and the error inspected deep (its cause and every property).
    const shown = `${error.message}\n${inspect(error, { depth: 10, showHidden: true })}`;
    assert.ok(!shown.includes(secret), `${what}: no password in ${shown.slice(0, 300)}`);
    assert.ok(!shown.includes("postgres://") && !shown.includes(`agentrun:${secret}`), `${what}: no URL`);
  }
});

test("a call whose connection the database stops answering mid-life is refused within the connect deadline (StoreDeadline), never left hanging", ONLY, async (t) => {
  const schema = await schemaFor(t);
  // The server sets the schema up on the test Postgres; a runner reaches it through a loopback host that forwards, then
  // stops answering (its open connections cut, new ones hanging).
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  const forward = { on: true };
  const host = await silentHost(t, forward);
  const through = new URL(PG_URL);
  through.host = `127.0.0.1:${host.port}`;
  const runner = await openPostgresStore({ url: through.href, schema, role: "runner", connectTimeoutMs: 300 });
  t.after(() => runner.close().catch(() => undefined));
  await runner.agents.list();
  forward.on = false;
  host.cut();
  // The pool's client was cut: the next call needs a new connection, which never answers. A first call may meet the cut
  // client itself (its error said at once); the call after it must connect anew.
  let outcome;
  for (let tries = 0; tries < 3; tries++) {
    outcome = await within(runner.agents.list(), 10_000);
    if (outcome === "hung" || outcome.error instanceof StoreDeadline) break;
  }
  assert.notEqual(outcome, "hung", "the call hung past 10 s");
  assert.ok(outcome.error instanceof StoreDeadline, `refused as a deadline: ${outcome.error ?? "answered"}`);
  assert.match(outcome.error.message, new RegExp(`127\\.0\\.0\\.1:${host.port}/`), "names the host");
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
  // A later build's migration, applied.
  await sql(schema, "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (2, 'later', 'x', 0)");
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, role: "runner" }), (error) => error instanceof SchemaVersionUnknown && error.found === 2 && error.known === 1);
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
  assert.deepEqual(migrations.map((m) => [m.version, m.name]), [[1, "initial"]]);
  const first = await openPostgresStore({ url: PG_URL, schema });
  await first.close();
  const second = await openPostgresStore({ url: PG_URL, schema });
  await second.close();
  const rows = await sql(schema, "SELECT version, name, sha256 FROM schema_migrations ORDER BY version");
  assert.deepEqual(rows.map((row) => [Number(row.version), row.name, row.sha256]), [[1, "initial", migrations[0].sha256]], "applied once");
});

test("a migration that fails leaves nothing of it: the schema's version is unchanged and its tables absent", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const connection = await PgConnection.open({ url: PG_URL, schema });
  t.after(() => connection.close());
  const broken = [...migrationsIn(), { version: 2, name: "broken", sql: "CREATE TABLE half_made (id BIGINT); SELECT no_such_function()", sha256: "y" }];
  await assert.rejects(connection.withClient((c) => migrate(c, schema, 0, broken)));
  assert.deepEqual(await sql(undefined, "SELECT nspname FROM pg_namespace WHERE nspname = $1", schema), [], "the first open's transaction rolled back whole, its schema too");
  await connection.withClient((c) => migrate(c, schema, 0));
  await assert.rejects(connection.withClient((c) => migrate(c, schema, 0, broken)));
  const rows = await sql(schema, "SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(rows.map((row) => Number(row.version)), [1], "version 2 not recorded");
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
