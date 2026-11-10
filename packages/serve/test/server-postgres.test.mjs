// A deployment on Postgres: the server started with AGENTRUN_STORE_URL opens that store (store/open.ts), never SQLite in
// its data directory, and holds the schema's owner lock; a runner started apart (`runner`, beside a `--no-runner` server)
// on the same URL and schema claims and runs what the server's API started, and the server reads it completed. With the
// server on SQLite and the runner on Postgres they are two stores, and the run is never claimed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agent, client, FAUX, follow, printed, scratch } from "./support.mjs";
import { client as pgClient, dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const { openPostgresStore, StoreOwned } = await import("../dist/store/index.js");

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

test("a deploy on Postgres: a second server waits for the first's owner lock instead of exiting; when the first's lock is lost it takes the schema and serves, and the first exits 1", { ...postgresOnly("a deployment's Postgres store"), timeout: 180_000 }, async (t) => {
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
  const start = (name) => {
    const child = cli(t, ["--data", join(root, name), "--port", "0", "--faux", FAUX, "--no-runner"], env);
    const err = [];
    createInterface({ input: child.stderr }).on("line", (line) => err.push(line));
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    return { child, err, exited };
  };
  const first = start("first");
  const firstPort = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(await printed(first.child, /^Open /m))[1]);
  // The second starts while the first holds the schema (a rolling deploy): it waits, saying so, and never exits.
  const second = start("second");
  const secondUp = printed(second.child, /^Open /m);
  secondUp.catch(() => undefined);
  for (const deadline = Date.now() + 30_000; !second.err.some((line) => /waiting up to \d+ s for it to let go/.test(line)) && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(second.err.some((line) => /another server holds the store in the Postgres schema \w+: waiting up to \d+ s/.test(line)), `the second says it waits: ${second.err.join("\n")}`);
  assert.equal(second.child.exitCode, null, "and has not exited");
  assert.equal((await fetch(`http://127.0.0.1:${firstPort}/v2/health`)).status, 200, "the first serves meanwhile");
  // The first's owner connection ends (a failover): the waiting second takes the schema before the first asks again.
  const admin = await pgClient();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2
      AND classid::bigint = (hashtext($1)::bigint & 4294967295) AND objid::bigint = (hashtext('owner')::bigint & 4294967295)`, [schema]);
  } finally {
    await admin.end();
  }
  const secondPort = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(await secondUp)[1]);
  assert.equal((await fetch(`http://127.0.0.1:${secondPort}/v2/health`)).status, 200, "the second serves the schema");
  const code = await Promise.race([first.exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 30_000))]);
  assert.equal(code, 1, `the first exits 1 once another server holds its schema: ${first.err.join("\n")}`);
  assert.ok(first.err.some((line) => /another server took the store in the Postgres schema/.test(line)), "saying why");
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
  const second = await openPostgresStore({ url: PG_URL, schema, role: "server", ownerWaitMs: 0 }).then(async (store) => (await store.close(), null), (error) => error);
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
