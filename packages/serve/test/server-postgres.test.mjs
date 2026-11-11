// A deployment on Postgres: the server started with AGENTRUN_STORE_URL opens that store (store/open.ts), never SQLite in
// its data directory, and holds the schema's owner lock; a runner started apart (`runner`, beside a `--no-runner` server)
// on the same URL and schema claims and runs what the server's API started, and the server reads it completed. With the
// server on SQLite and the runner on Postgres they are two stores, and the run is never claimed. A role with no CREATE on
// the database starts the server on a schema an administrator made ahead of time and gave it, and is refused, in words that
// say what to do, on a schema that does not exist.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { agent, client, FAUX, follow, printed, scratch } from "./support.mjs";
import { client as pgClient, dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const { migrationsIn, openPostgresStore, StoreOwned } = await import("../dist/store/index.js");

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"p".repeat(40)}`;
const SEAL = Buffer.alloc(32, 7).toString("base64");

/** `node dist/cli.js ...args` on `env` (no launcher: secrets.ts reads the store URL from its own environment), stopped and
 *  waited for after the test. */
function cli(t, args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  return child;
}

/** The environment a server on the Postgres store at `url`, in `schema`, starts with. */
function storeEnv(root, url, schema) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: process.env.TMPDIR ?? root,
    AGENTRUN_ACCOUNTS: "0",
    AGENTRUN_TOKEN: TOKEN,
    AGENTRUN_SEAL_KEY: SEAL,
    AGENTRUN_STORE_URL: url,
    AGENTRUN_STORE_SCHEMA: schema,
  };
}

/** `text` on the test database as its own user (an administrator), on a client of its own. */
async function admin(text, params = []) {
  const c = await pgClient();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** A login role of the test's own, not a superuser, with no CREATE on the database (asserted, not assumed), dropped after
 *  the test with what it owns. Answers its name and the test database's URL as that role. */
async function roleWithoutCreate(t) {
  const role = `${await freshSchema()}_role`;
  // A password made here, for a role that lives only as long as the test: none is written in this file.
  const password = randomBytes(18).toString("hex");
  await admin(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  t.after(async () => {
    await admin("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [role]);
    await admin(`DROP OWNED BY ${role} CASCADE`);
    await admin(`DROP ROLE IF EXISTS ${role}`);
  });
  const [{ db }] = await admin("SELECT quote_ident(current_database()) AS db");
  await admin(`REVOKE CREATE ON DATABASE ${db} FROM ${role}`);
  const [{ can_create: create }] = await admin("SELECT has_database_privilege($1, current_database(), 'CREATE') AS can_create", [role]);
  assert.equal(create, false, "the role has no CREATE on the database, from any grant");
  const url = new URL(PG_URL);
  url.username = role;
  url.password = password;
  return { role, url: url.href };
}

test("a role with no CREATE on the database starts the server on a schema an administrator made ahead of time and gave it, and the server migrates it", { ...postgresOnly("a deployment's Postgres store"), timeout: 120_000 }, async (t) => {
  const { role, url } = await roleWithoutCreate(t);
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  await admin(`CREATE SCHEMA ${schema} AUTHORIZATION ${role}`);
  const root = await scratch(t);
  const server = cli(t, ["--data", join(root, "agents"), "--port", "0", "--faux", FAUX, "--no-runner"], storeEnv(root, url, schema));
  const out = await printed(server, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const health = await fetch(`http://127.0.0.1:${port}/v2/health`);
  assert.deepEqual({ status: health.status, body: await health.json() }, { status: 200, body: { status: "ok", checks: { store: "ok", disk: "ok" } } });
  const applied = await admin(`SELECT version FROM ${schema}.schema_migrations ORDER BY version`);
  assert.deepEqual(applied.map((row) => Number(row.version)), migrationsIn().map((m) => m.version), "every migration applied to the schema");
  const [{ owner }] = await admin("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [schema]);
  assert.equal(owner, role, "the schema is still the one the administrator made for the role");
});

test("a role with no CREATE on the database, on a schema that does not exist, is refused at the server's start, naming the schema and what to do", { ...postgresOnly("a deployment's Postgres store"), timeout: 120_000 }, async (t) => {
  const { url } = await roleWithoutCreate(t);
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const root = await scratch(t);
  const server = cli(t, ["--data", join(root, "agents"), "--port", "0", "--faux", FAUX, "--no-runner"], storeEnv(root, url, schema));
  const refused = await printed(server, /^Open /m).then(() => undefined, (error) => error);
  assert.ok(refused, "the server did not start");
  assert.match(refused.message, /the server exited \(1\)/);
  assert.match(refused.message, new RegExp(`the Postgres schema ${schema} does not exist, and this role may not create it \\(no CREATE on the database\\): create the schema ahead of time, owned by this role, or grant this role CREATE on the database`));
  assert.ok(!refused.message.includes(new URL(url).password), "never the password");
  assert.deepEqual(await admin("SELECT nspname FROM pg_namespace WHERE nspname = $1", [schema]), [], "no schema made");
});

/** `text` on the test database as `url`'s role, answered with its rows, or the error it was refused with. */
async function asRole(url, text) {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  await c.connect();
  try {
    return await c.query(text).then((result) => result.rows, (error) => error);
  } finally {
    await c.end();
  }
}

test("a least-privilege deployment (a host's three roles): the server as the schema's owner with no CREATE on the database migrates and serves; a runner as a write-only role runs what the server started and may not change the schema; a reader with no grants reads nothing", { ...postgresOnly("a deployment's Postgres store"), timeout: 180_000 }, async (t) => {
  // The roles a host makes (grep's agentrun_migrator, agentrun_runtime, grep_agentrun_reader): none may create a schema.
  const migrator = await roleWithoutCreate(t);
  const runtime = await roleWithoutCreate(t);
  const reader = await roleWithoutCreate(t);
  // The schema made ahead by an administrator, owned by the migrator. The runtime role reads and writes the migrator's
  // tables through its default privileges, set before the server makes any; the reader is granted nothing.
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  await admin(`CREATE SCHEMA ${schema} AUTHORIZATION ${migrator.role}`);
  await admin(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
  await admin(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime.role}`);
  await admin(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator.role} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime.role}`);
  await admin(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator.role} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${runtime.role}`);
  const root = await scratch(t);
  const data = join(root, "agents");
  const server = cli(t, ["--data", data, "--port", "0", "--faux", FAUX, "--no-runner"], storeEnv(root, migrator.url, schema));
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(await printed(server, /^Open /m))[1]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/health`)).status, 200, "the server migrated the schema and serves");
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  assert.equal((await api("POST", "/agents", agent("plain", { place: { mode: "runner" } }))).status, 201);
  const run = await api("POST", "/agents/plain/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // The runner as the runtime role: it claims, journals and ends the run on its grants alone.
  const runner = cli(t, ["runner", "--data", data], { ...storeEnv(root, runtime.url, schema), AGENTRUN_RUNNER_NAME: "runner-runtime", AGENTRUN_SERVE_FAUX: FAUX });
  const err = [];
  createInterface({ input: runner.stderr }).on("line", (line) => err.push(line));
  const runnerExit = new Promise((resolve) => runner.once("exit", (code) => (err.push(`exited ${code}`), resolve(code))));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", `the run, under the runtime role: ${last.status} ${err.join("\n")}`);
  // A faux run ends before the runner's first renew tick, so the renew is driven here, with the runner stopped: a run
  // started through the API is claimed, its claim renewed (its lease moving on) and released, all as the runtime role.
  runner.kill("SIGTERM");
  await runnerExit;
  const queued = await api("POST", "/agents/plain/runs", { input: { content: "Again." } });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const runtimeStore = await openPostgresStore({ url: runtime.url, schema, role: "runner" });
  t.after(() => runtimeStore.close());
  const claim = await runtimeStore.claim(queued.body.run_id, "runner-runtime", { leaseMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [renewed] = await runtimeStore.renewMany([claim], { leaseMs: 30_000 });
  assert.ok(renewed.until > claim.until, `the runtime role renews a claim, its lease moved on: ${claim.until} -> ${renewed.until}`);
  await runtimeStore.release(renewed);
  // The runtime role may not change the schema, and the reader may not read or open it.
  const ddl = await asRole(runtime.url, `CREATE TABLE ${schema}.extra (id int)`);
  assert.equal(ddl?.code, "42501", `the runtime role may not create a table: ${ddl?.message ?? "created"}`);
  const drop = await asRole(runtime.url, `DROP TABLE ${schema}.runs`);
  assert.equal(drop?.code, "42501", `nor drop one: ${drop?.message ?? "dropped"}`);
  const read = await asRole(reader.url, `SELECT id FROM ${schema}.runs`);
  assert.equal(read?.code, "42501", `the reader reads nothing: ${read?.message ?? "read"}`);
  await assert.rejects(openPostgresStore({ url: reader.url, schema, role: "runner" }), "and opens no store");
});

test("a server on Postgres whose store stops reading (its schema dropped under it) answers /v2/health 503 does_not_open, within the health bound", { ...postgresOnly("a deployment's Postgres store"), timeout: 120_000 }, async (t) => {
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const root = await scratch(t);
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: process.env.TMPDIR ?? root,
    AGENTRUN_ACCOUNTS: "0",
    AGENTRUN_TOKEN: TOKEN,
    AGENTRUN_SEAL_KEY: SEAL,
    AGENTRUN_STORE_URL: PG_URL,
    AGENTRUN_STORE_SCHEMA: schema,
  };
  const server = cli(t, ["--data", join(root, "agents"), "--port", "0", "--faux", FAUX, "--no-runner"], env);
  const out = await printed(server, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/health`)).status, 200, "healthy on its store");
  await dropSchema(schema);
  const startedAt = Date.now();
  const broken = await fetch(`http://127.0.0.1:${port}/v2/health`);
  assert.deepEqual({ status: broken.status, body: await broken.json() }, { status: 503, body: { status: "failing", checks: { store: "does_not_open", disk: "ok" } } });
  assert.ok(Date.now() - startedAt < 5_000, `answered within the health bound, not ${Date.now() - startedAt} ms`);
});

test("a server started on AGENTRUN_STORE_URL opens that Postgres store under its owner lock, and a runner started apart on it runs what the server's API started, which the server reads completed", { ...postgresOnly("a deployment's Postgres store"), timeout: 180_000 }, async (t) => {
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const root = await scratch(t);
  const data = join(root, "agents");
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: process.env.TMPDIR ?? root,
    AGENTRUN_ACCOUNTS: "0",
    AGENTRUN_TOKEN: TOKEN,
    AGENTRUN_SEAL_KEY: SEAL,
    AGENTRUN_STORE_URL: PG_URL,
    AGENTRUN_STORE_SCHEMA: schema,
  };
  const server = cli(t, ["--data", data, "--port", "0", "--faux", FAUX, "--no-runner"], env);
  const out = await printed(server, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  // The server's store is the Postgres schema, and the server holds it: a second server on the schema is refused, and no
  // SQLite store was made in the data directory.
  const second = await openPostgresStore({ url: PG_URL, schema, role: "server" }).then(async (store) => (await store.close(), null), (error) => error);
  assert.ok(second instanceof StoreOwned, `the server holds the schema's owner lock: ${second ?? "a second server opened it"}`);
  assert.equal(existsSync(join(data, "store.sqlite")), false, "no SQLite store in the data directory");
  // Health reads that store (a compose's runners wait for it: depends_on service_healthy), never a file in the data dir.
  const health = await fetch(`http://127.0.0.1:${port}/v2/health`);
  assert.deepEqual({ status: health.status, body: await health.json() }, { status: 200, body: { status: "ok", checks: { store: "ok", disk: "ok" } } });
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  // On the runner: the store is what is tested here, not a box (this machine's docker may be set up or not).
  assert.equal((await api("POST", "/agents", agent("plain", { place: { mode: "runner" } }))).status, 201);
  const run = await api("POST", "/agents/plain/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // The runner apart: the faux model by the variable a run's process reads it from (server.ts fauxEnvOf).
  const runner = cli(t, ["runner", "--data", data], { ...env, AGENTRUN_RUNNER_NAME: "runner-apart", AGENTRUN_SERVE_FAUX: FAUX });
  const err = [];
  createInterface({ input: runner.stderr }).on("line", (line) => err.push(line));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line within 60 s: ${err.join("\n")}`)), 60_000);
    createInterface({ input: runner.stdout }).on("line", (line) => {
      if (/^Runner runner-apart ready: store postgres /.test(line)) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    runner.once("exit", () => reject(new Error(`the runner exited before ready: ${err.join("\n")}`)));
  });
  assert.match(ready, /store postgres/);
  const { last, rows } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  const read = await api("GET", `/runs/${run.body.run_id}`);
  assert.equal(last.status, "completed", `the run ended ${last.status}: ${JSON.stringify(read.body)} ${err.join("\n")}`);
  assert.ok(JSON.stringify(rows).includes("On Say hello.: done."), `the faux model's answer: ${JSON.stringify(rows)}`);
});
