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

const { migrate, migrationsIn, openPostgresStore, postgresVersionOf: versionOf, postgresWhere, openStore, PgConnection, SchemaVersionUnknown, storeTarget, StoreBusy, StoreConstraint, STORE_CONNECT_TIMEOUT_MS, StoreDeadline, StoreOwned, Unanswered, LEASE_DEADLINE_MS } = await import("../dist/store/index.js");
const { RUNNER_RENEW_EVERY_MS, RunnerRefused, startRunnerProcess } = await import("../dist/runner/main.js");

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

/** Ends the session holding `schema`'s owner lock from outside (the database restarted it, a failover, an operator):
 *  found by the advisory lock it holds, (hashtext(schema), hashtext('owner')). */
const killOwner = (schema) => sql(schema, `SELECT pg_terminate_backend(pid) AS gone FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2
    AND classid::bigint = (hashtext($1)::bigint & 4294967295) AND objid::bigint = (hashtext('owner')::bigint & 4294967295)`, schema);

/** The first refusal of a write on `store`, tried until `ms` pass (a store hears of a lost connection when its end reaches
 *  it: each try before that is a write that still lands), or undefined. */
async function refusedWithin(store, ms) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    const refused = await store.agents.put({ id: "agent-1", name: "Agent" }).then(() => undefined, (error) => error);
    if (refused) return refused;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return undefined;
}

test("a server whose owner lock's connection is killed refuses every call until it takes the lock back on a fresh connection, then serves again, still the schema's one server", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  await server.agents.put({ id: "agent-1", name: "Agent" });
  assert.deepEqual((await killOwner(schema)).map((row) => row.gone), [true], "the owner lock's one connection ended");
  const refused = await refusedWithin(server, 10_000);
  assert.ok(refused instanceof StoreOwned, `refused while the lock is not held: ${refused}`);
  await assert.rejects(server.agents.get("agent-1"), StoreOwned, "and so is a read");
  // Taken back (after its 1 s delay): the server serves again, on its new owner connection.
  let served;
  for (const deadline = Date.now() + 10_000; !served && Date.now() < deadline; ) {
    served = await server.agents.get("agent-1").catch(() => undefined);
    if (!served) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(served?.name, "Agent", "it serves again once the lock is its own again");
  assert.deepEqual((await sql(schema, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", `agentrun-store-owner:${schema}`))[0].n, 1, "one owner connection, its new one");
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, ownerWaitMs: 0 }), StoreOwned, "and it is the schema's one server");
});

test("a server that takes its lost owner lock back on a schema a newer build migrated meanwhile gives it up for good: told (onOwnerLost), naming both versions, never serving the schema", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const lost = [];
  const server = await openPostgresStore({ url: PG_URL, schema, onOwnerLost: (error) => lost.push(error) });
  t.after(() => server.close());
  const known = migrationsIn().at(-1).version;
  // A newer server took the schema while the lock was not held, migrated it and let it go: its version is past this build's.
  await killOwner(schema);
  await sql(schema, "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES ($1, 'newer', 'x', 0)", known + 1);
  for (const deadline = Date.now() + 10_000; lost.length === 0 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(lost.length, 1, "told once");
  assert.match(lost[0].message, new RegExp(`the schema is at version ${known + 1} now, and this build knows ${known}`));
  await assert.rejects(server.agents.get("agent-1"), (error) => error === lost[0], "every call refused");
  // The lock let go: a server of this build opening the schema now is refused by its version, never by the owner lock.
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, ownerWaitMs: 0 }), (error) => !(error instanceof StoreOwned), "not StoreOwned: the lock was given up");
});

test("a server whose lost owner lock can't be taken back (the database never answers) gives it up at the end of its wait: told (onOwnerLost), never refusing calls for ever", ONLY, async (t) => {
  const schema = await schemaFor(t);
  // Set up directly, then reached only through a host that forwards until it is told to stop.
  await (await openPostgresStore({ url: PG_URL, schema })).close();
  const forward = { on: true };
  const host = await silentHost(t, forward);
  const through = new URL(PG_URL);
  through.host = `127.0.0.1:${host.port}`;
  const lost = [];
  const server = await openPostgresStore({ url: through.href, schema, ownerWaitMs: 2_000, connectTimeoutMs: 500, onOwnerLost: (error) => lost.push(error) });
  t.after(() => server.close());
  // Every connection cut, the owner lock's with them, and every new one hangs: the take-back never gets an answer.
  forward.on = false;
  host.cut();
  const startedAt = Date.now();
  for (const deadline = Date.now() + 15_000; lost.length === 0 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(lost.length, 1, "told once the wait ran out");
  assert.match(lost[0].message, /could not be taken back within 2 s/);
  assert.ok(Date.now() - startedAt < 10_000, `within its wait and the connect bound, not ${Date.now() - startedAt} ms`);
});

test("a second server waits for the owner lock while the first holds it, and takes the schema once the first stops", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const first = await openPostgresStore({ url: PG_URL, schema });
  await first.agents.put({ id: "agent-1", name: "Agent" });
  const said = [];
  const second = openPostgresStore({ url: PG_URL, schema, ownerWaitMs: 20_000, warn: (message) => said.push(message) });
  second.catch(() => undefined);
  t.after(async () => (await second.catch(() => undefined))?.close());
  assert.equal(await within(second, 1_500), "hung", "still waiting while the first holds the schema");
  assert.match(said.join("\n"), /another server holds the store in the Postgres schema \w+: waiting up to 20 s for it to let go/, "said once that it waits");
  await first.close();
  const took = await within(second, 5_000);
  assert.notEqual(took, "hung", "the second server opened once the first stopped");
  assert.equal((await took.value.agents.get("agent-1"))?.name, "Agent", "and serves the schema");
});

test("a server that waited out its whole wait for another server's owner lock is refused (StoreOwned), saying how long it waited", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const first = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => first.close());
  const startedAt = Date.now();
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, ownerWaitMs: 1_000 }), (error) => error instanceof StoreOwned && /another server holds the store in the Postgres schema \w+, and still held it after 1 s/.test(error.message));
  assert.ok(Date.now() - startedAt < 5_000, "within its wait");
});

test("a server whose owner lock another server takes while its connection is lost is lost for good: told (onOwnerLost) and refusing every call from then", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const lost = [];
  const first = await openPostgresStore({ url: PG_URL, schema, onOwnerLost: (error) => lost.push(error) });
  t.after(() => first.close());
  await first.agents.put({ id: "agent-1", name: "Agent" });
  // A second server waiting for the schema (a deploy's new one): it asks every 250 ms, the first only 1 s after its loss.
  const second = openPostgresStore({ url: PG_URL, schema, ownerWaitMs: 20_000 });
  second.catch(() => undefined);
  t.after(async () => (await second.catch(() => undefined))?.close());
  assert.equal(await within(second, 500), "hung", "the second waits");
  await killOwner(schema);
  const took = await within(second, 5_000);
  assert.notEqual(took, "hung", "the second server took the schema");
  for (const deadline = Date.now() + 10_000; lost.length === 0 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(lost.length, 1, "the first is told once");
  assert.ok(lost[0] instanceof StoreOwned && /another server took the store in the Postgres schema/.test(lost[0].message), String(lost[0]));
  await assert.rejects(first.agents.get("agent-1"), (error) => error === lost[0], "every call refused with it");
  assert.equal((await took.value.agents.get("agent-1"))?.name, "Agent", "the second serves the schema");
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

test("openStore's Postgres pool holds at most AGENTRUN_STORE_POOL_SIZE connections, as the server and as a runner", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-pool-size-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { AGENTRUN_STORE_SCHEMA: schema, AGENTRUN_STORE_POOL_SIZE: "2" };
  const server = await openStore({ dataDir: dir, role: "server", url: PG_URL, env });
  t.after(() => server.close().catch(() => undefined));
  const runner = await openStore({ dataDir: dir, role: "runner", url: PG_URL, env });
  t.after(() => runner.close().catch(() => undefined));
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  for (const [who, store] of [["server", server], ["runner", runner]]) {
    // A session of the test's own holds the agents table; five reads of it through the store each wait on that lock with
    // a pool client of their own, so the sessions blocked behind the holder are the pool's size, not the reads' count.
    const holder = await client(schema);
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE agents IN ACCESS EXCLUSIVE MODE");
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const reads = Array.from({ length: 5 }, () => store.agents.list());
    for (const read of reads) read.catch(() => undefined);
    const blocked = async () => (await sql(schema, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", holderPid))[0].n;
    const until = Date.now() + 3_000;
    while ((await blocked()) < 2 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await blocked(), 2, `${who}: two of the five reads hold a connection, the others wait for one`);
    await holder.query("ROLLBACK");
    await holder.end();
    for (const read of await Promise.all(reads)) assert.deepEqual(read.map((agent) => agent.id), ["agent-1"], `${who}: every read is answered once the lock goes`);
  }
});

/** A TCP server on loopback that takes every connection and never says a word (a database host that hangs), closed
 *  after the test. With `forward`, a connection is piped to the test Postgres instead while `forward.on` is true; set it
 *  false and every connection open is cut, and new ones hang. */
async function silentHost(t, forward) {
  const sockets = new Set();
  const pairs = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (forward?.on) {
      const target = new URL(PG_URL);
      const upstream = connect(Number(target.port || 5432), target.hostname);
      upstreams.add(upstream);
      upstream.on("close", () => upstreams.delete(upstream));
      const pair = { socket, upstream, cutOff: false };
      upstream.on("error", () => socket.destroy());
      // Cut off (partition): the client's close never reaches the database, whose session stays open, idle.
      socket.on("close", () => { if (!pair.cutOff) upstream.destroy(); });
      upstream.on("close", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
      pairs.add(pair);
      socket.on("close", () => pairs.delete(pair));
    }
  });
  const upstreams = new Set();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    for (const upstream of upstreams) upstream.destroy();
    server.close(resolve);
  }));
  const freeze = (cutOff) => {
    for (const pair of pairs) {
      pair.cutOff = cutOff;
      pair.socket.unpipe(pair.upstream);
      pair.upstream.unpipe(pair.socket);
      pair.socket.pause();
      pair.upstream.pause();
    }
  };
  return {
    port: server.address().port,
    cut: () => { for (const socket of sockets) socket.destroy(); },
    // Every forwarded connection goes silent and stays open: no byte either way, no FIN, no RST (a load balancer's idle
    // drop, a failover whose old address stops answering).
    freeze: () => freeze(false),
    // As freeze, and a partition: nothing the client does after (its close) reaches the database, nor the database's
    // keepalives the client; the database finds the session dead only by its own timeouts.
    partition: () => freeze(true),
  };
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

test("a renew after the lease connection's backend died gets a fresh lease connection within the connect deadline: the claim holds, the process lives", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  await queued(server, "run-0");
  const runner = await openPostgresStore({ url: PG_URL, schema, role: "runner", connectTimeoutMs: 1_000 });
  t.after(() => runner.close().catch(() => undefined));
  const claim = await runner.claim("run-0", "runner-a", { leaseMs: 30_000 });
  await runner.renew(claim, { leaseMs: 30_000 });
  // The lease connection, idle, ended from outside (an operator, a database restart): found by its name.
  const ended = await sql(schema, "SELECT pg_terminate_backend(pid) AS gone FROM pg_stat_activity WHERE application_name = $1", `agentrun-store-lease:${schema}`);
  assert.deepEqual(ended.map((row) => row.gone), [true], "the lease connection's one backend ended");
  // Gone from the database before the renew (its socket's end reaches the pool as the backend exits).
  while ((await sql(schema, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", `agentrun-store-lease:${schema}`))[0].n > 0) await new Promise((resolve) => setImmediate(resolve));
  // The next renew, on its own timer: a fresh lease connection, the claim still held. A renew that met the dead client
  // before the pool dropped it is said at once (a connection error, never a hang) and the one after it must land.
  const started = Date.now();
  let renewed;
  for (let tries = 0; tries < 2 && !renewed; tries++) {
    const outcome = await within(runner.renewMany([claim], { leaseMs: 30_000 }), 3_000);
    assert.notEqual(outcome, "hung", "the renew hung");
    if (!outcome.error) renewed = outcome.value;
  }
  assert.equal(renewed?.[0]?.runId, "run-0", "renewed: the claim holds");
  // At most two tries (one may meet the dead client and fail at once), each bounded by the 1 s connect deadline.
  assert.ok(Date.now() - started < 4_000, `within the connect deadline, twice at most (${Date.now() - started} ms)`);
  const fresh = await sql(schema, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", `agentrun-store-lease:${schema}`);
  assert.equal(fresh[0].n, 1, "on a fresh lease connection, never the shared pool");
});

test("a renew whose lease connection goes silent (open, no answer, no reset) fails before the runner's next renew tick, and the next renew lands on a fresh connection", ONLY, async (t) => {
  // The bound, its commit's 1 s floor with it, fits under the runner's renew interval.
  assert.ok(LEASE_DEADLINE_MS + 1_000 < RUNNER_RENEW_EVERY_MS, `${LEASE_DEADLINE_MS} ms + 1 s under ${RUNNER_RENEW_EVERY_MS} ms`);
  const schema = await schemaFor(t);
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  await queued(server, "run-0");
  const forward = { on: true };
  const host = await silentHost(t, forward);
  const through = new URL(PG_URL);
  through.host = `127.0.0.1:${host.port}`;
  const runner = await openPostgresStore({ url: through.href, schema, role: "runner", connectTimeoutMs: 500 });
  const claim = await runner.claim("run-0", "runner-a", { leaseMs: 30_000 });
  await runner.renewMany([claim], { leaseMs: 30_000 });
  // The lease connection (and every other one) still open, gone silent.
  host.freeze();
  // The runner (lease 30 s, renew every 10 s, stop margin 5 s): a renew sent at +10 s that fails before +20 s leaves the
  // +20 s tick to renew on a fresh connection before the +25 s stop. One still running at +20 s has that tick skipped.
  const sentAt = Date.now();
  const outcome = await within(runner.renewMany([claim], { leaseMs: 30_000 }), 15_000);
  const tookMs = Date.now() - sentAt;
  assert.notEqual(outcome, "hung", "the renew hung on a silent connection");
  assert.ok(outcome.error instanceof StoreDeadline, `refused at its deadline: ${outcome.error ?? "renewed"}`);
  assert.equal(outcome.error.deadlineMs, LEASE_DEADLINE_MS, "the lease's own deadline, from its call");
  assert.ok(tookMs < RUNNER_RENEW_EVERY_MS, `failed within ${RUNNER_RENEW_EVERY_MS} ms of its call, not ${tookMs} ms`);
  // New connections are not silent: the next renew opens one and lands, the claim still held.
  const next = await within(runner.renewMany([claim], { leaseMs: 30_000 }), 5_000);
  assert.equal(next.value?.[0]?.runId, "run-0", `the next renew lands on a fresh connection: ${next.error ?? next}`);
  const closed = await within(runner.close(), 5_000);
  assert.notEqual(closed, "hung", "the store's close hung");
});

test("a transaction whose connection goes silent mid-way is let go at its deadline, one silent at its commit within the commit's bound (Unanswered), never waiting on a rollback", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const silentAt = async (freezeWhere, { read = false } = {}) => {
    const host = await silentHost(t, { on: true });
    const through = new URL(PG_URL);
    through.host = `127.0.0.1:${host.port}`;
    const connection = await PgConnection.open({ url: through.href, schema, connectTimeoutMs: 500 });
    const outcome = connection.transaction(async (tx) => {
      if (freezeWhere === "mid-way") host.freeze();
      const { one } = await tx.get("SELECT 1 AS one");
      if (freezeWhere === "at its commit") host.freeze();
      return one;
    }, { deadlineMs: 1_000, read });
    return { connection, outcome };
  };
  // Silent before a statement answers: StoreDeadline at the transaction's own 1 s, its client let go, no ROLLBACK waited
  // on (a silent connection never answers one).
  const mid = await silentAt("mid-way");
  const midOutcome = await within(mid.outcome, 4_000);
  assert.notEqual(midOutcome, "hung", "the transaction waited on a silent connection past its deadline");
  assert.ok(midOutcome.error instanceof StoreDeadline, `refused at its deadline: ${midOutcome.error ?? midOutcome.value}`);
  assert.equal(midOutcome.error.deadlineMs, 1_000);
  assert.notEqual(await within(mid.connection.close(), 3_000), "hung", "the connection's close hung");
  // Silent at the commit: its outcome is unknown, so Unanswered (never StoreDeadline, which says nothing was written), within
  // what is left of its deadline (1 s at least), never past it by more.
  const late = await silentAt("at its commit");
  const lateOutcome = await within(late.outcome, 4_000);
  assert.notEqual(lateOutcome, "hung", "the commit waited on a silent connection past its deadline");
  assert.ok(lateOutcome.error instanceof Unanswered, `the commit unanswered: ${lateOutcome.error ?? lateOutcome.value}`);
  assert.notEqual(await within(late.connection.close(), 3_000), "hung", "the connection's close hung");
  // A read silent at its commit: its snapshot has nothing to land, so what it read stands.
  const read = await silentAt("at its commit", { read: true });
  const readOutcome = await within(read.outcome, 4_000);
  assert.notEqual(readOutcome, "hung", "the read's commit waited on a silent connection past its deadline");
  assert.equal(readOutcome.value, 1, `the read's value: ${readOutcome.error ?? ""}`);
  assert.notEqual(await within(read.connection.close(), 3_000), "hung", "the connection's close hung");
});

test("a single statement (get, all, run outside a transaction) on a connection gone silent is Unanswered past the transaction deadline and the busy wait, and the store still closes", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const host = await silentHost(t, { on: true });
  const through = new URL(PG_URL);
  through.host = `127.0.0.1:${host.port}`;
  const connection = await PgConnection.open({ url: through.href, schema, poolSize: 1, connectTimeoutMs: 500 });
  assert.equal((await connection.get("SELECT 1 AS one")).one, 1);
  // The pool's one client, idle, gone silent: the next statement is sent on it.
  host.freeze();
  // Its bound: 10 s (the deadline and the busy wait both) + 2 s.
  const outcome = await within(connection.get("SELECT 1 AS one"), 15_000);
  assert.notEqual(outcome, "hung", "the statement hung on a silent connection");
  assert.ok(outcome.error instanceof Unanswered, `unanswered: ${outcome.error ?? JSON.stringify(outcome.value)}`);
  assert.notEqual(await within(connection.close(), 3_000), "hung", "the connection's close hung");
});

test("a transaction whose client vanished mid-way (a partition: the database never hears it go) lets its row locks go once idle past its deadline", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  await queued(server, "run-0");
  const host = await silentHost(t, { on: true });
  const through = new URL(PG_URL);
  through.host = `127.0.0.1:${host.port}`;
  const connection = await PgConnection.open({ url: through.href, schema, connectTimeoutMs: 500 });
  t.after(() => connection.close());
  const outcome = connection.transaction(async (tx) => {
    await tx.get("SELECT id FROM runs WHERE id = ? FOR UPDATE", "run-0");
    host.partition();
    await tx.get("SELECT 1 AS one");
  }, { deadlineMs: 1_000 });
  assert.ok((await within(outcome, 4_000)).error instanceof StoreDeadline, "the transaction let go at its deadline");
  // The row stays locked by the vanished session until the database ends it: idle in its transaction past its deadline
  // and the slack (1 s + 5 s). Its statement_timeout never fires on an idle session, and the default keepalive is 2 h.
  const watcher = await client(schema);
  t.after(() => watcher.end().catch(() => undefined));
  const startedAt = Date.now();
  for (;;) {
    const got = await watcher.query("SELECT id FROM runs WHERE id = 'run-0' FOR UPDATE SKIP LOCKED");
    if (got.rows.length === 1) break;
    assert.ok(Date.now() - startedAt < 12_000, "the run's row still locked by a session whose client vanished");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

test("a store's sessions ask the database for TCP keepalives every 10 s, so a vanished client's session ends in about 25 s, not the OS's 2 h", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const connection = await PgConnection.open({ url: PG_URL, schema });
  t.after(() => connection.close());
  const shown = await connection.get("SELECT current_setting('tcp_keepalives_idle') AS idle, current_setting('tcp_keepalives_interval') AS every, current_setting('tcp_keepalives_count') AS count");
  assert.deepEqual(shown, { idle: "10", every: "5", count: "3" });
});

test("a callback that catches a failed statement's typed error and returns still rejects with that error (StoreConstraint), never a plain Error", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const connection = await PgConnection.open({ url: PG_URL, schema });
  t.after(() => connection.close());
  const outcome = await connection.transaction(async (tx) => {
    await tx.exec("CREATE TEMP TABLE once (k int PRIMARY KEY)");
    await tx.run("INSERT INTO once VALUES (1)");
    await tx.run("INSERT INTO once VALUES (1)").catch(() => undefined);
    return "returned";
  }).then((value) => ({ value }), (error) => ({ error }));
  assert.ok(outcome.error instanceof StoreConstraint, `StoreConstraint: ${outcome.error?.name ?? ""} ${outcome.error ?? outcome.value}`);
});

test("a backend that dies while its client is checked out (a transaction open) fails that call, never the process", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  await queued(server, "run-0");
  const runner = await openPostgresStore({ url: PG_URL, schema, role: "runner" });
  t.after(() => runner.close().catch(() => undefined));
  const claim = await runner.claim("run-0", "runner-a", { leaseMs: 30_000 });
  // A transaction held open (a renew waiting on another session's lock on its run), its backend ended under it.
  const holder = await client(schema);
  t.after(() => holder.end().catch(() => undefined));
  await holder.query("BEGIN");
  await holder.query("SELECT 1 FROM runs WHERE id = 'run-0' FOR UPDATE");
  const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const renew = runner.renewMany([claim], { leaseMs: 30_000 });
  renew.catch(() => undefined);
  // Watched from a session of its own: inside the holder's transaction pg_stat_activity is one snapshot, taken at its
  // first read, and would never show the renew's wait.
  const watcher = await client(schema);
  t.after(() => watcher.end().catch(() => undefined));
  let waiting;
  for (const until = Date.now() + 5_000; ; ) {
    assert.ok(Date.now() < until, "the renew never waited on the held run row");
    waiting = (await watcher.query("SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [holderPid])).rows[0];
    if (waiting) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  // An uncaught error from here fails this test (node:test reports it as the test's own failure).
  await watcher.query("SELECT pg_terminate_backend($1)", [waiting.pid]);
  const outcome = await within(renew, 5_000);
  await holder.query("ROLLBACK");
  assert.notEqual(outcome, "hung", "the renew hung");
  assert.ok(outcome.error instanceof Error, `the renew failed with its connection: ${outcome.value ? "renewed" : outcome.error}`);
  const after = await within(runner.renewMany([claim], { leaseMs: 30_000 }), 5_000);
  assert.equal(after.value?.[0]?.runId, "run-0", `the next renew lands on a fresh connection: ${after.error ?? ""}`);
});

test("a write on a store whose every pool client is held is refused at the connect deadline (StoreDeadline), never left waiting for one", ONLY, async (t) => {
  const schema = await schemaFor(t);
  const { runner, letGo } = await saturated(t, schema, { size: 2, connectTimeoutMs: 500 });
  const outcome = await within(runner.agents.put({ id: "agent-x", name: "X" }), 3_000);
  await letGo();
  assert.notEqual(outcome, "hung", "the write hung");
  assert.ok(outcome.error instanceof StoreDeadline, `refused at the connect deadline: ${outcome.error ?? "written"}`);
  assert.equal(outcome.error.deadlineMs, 500, "the connect deadline's, not another");
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
    // A typo in the port: the URL's own parse fails, before any connection.
    malformed: `postgres://agentrun:${secret}@127.0.0.1:bad/agentrun`,
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
  await assert.rejects(openPostgresStore({ url: PG_URL, schema, role: "server", ownerWaitMs: 0 }), (error) => error instanceof StoreOwned && /another server holds the store in the Postgres schema/.test(error.message));
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
