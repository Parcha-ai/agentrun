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
import { dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

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
