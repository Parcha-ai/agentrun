// A runner on a disk of its own (runner/disk-free.ts): a server and a runner with separate data directories on one
// Postgres. The server says its data root's id in the store at its start; a runner whose --data holds another (or none)
// is disk-free:
//   - in Mode 2 (Archil settings saved) it completes a run the server's API started, its run's folder on Archil, nothing of
//     the run in its own data directory but its own scratch;
//   - in Mode 1 (the run's folder would be on the server's disk, which it can't see) it claims nothing and says why: on its
//     stderr, and on its presence row, so the server refuses a launch in those words while no runner that can serve is
//     there. The run is never failed by the disk-free runner: once a runner on the server's data directory is there, the
//     launch is taken and that runner completes it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { agent, client, FAUX, follow, printed, scratch } from "./support.mjs";
import { connectionsLeft, dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";
import { until } from "./runner-support.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { archilControlFetch } from "./archil-control-fake.mjs";

const { openPostgresStore } = await import("../dist/store/index.js");
const { saveArchilSettings } = await import("../dist/archil-settings.js");
const { startRunnerProcess, runnerComputers, ofStore } = await import("../dist/runner/main.js");
const { dispatchRunner } = await import("../dist/runner/harness-loops.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { DATA_ROOT_FILE, DATA_ROOT_KEY, DISK_FREE_MODE_1, diskFreeRefusal } = await import("../dist/runner/disk-free.js");

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"d".repeat(40)}`;
const SEAL = Buffer.alloc(32, 9).toString("base64");
const REGION = "aws-us-east-1";
const FAKE_ARCHIL = "fake-test-key-archil-diskfree-01";

/** The environment a process on the Postgres store at `schema` starts with. */
function storeEnv(root, schema, more = {}) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: process.env.TMPDIR ?? root,
    AGENTRUN_ACCOUNTS: "0",
    AGENTRUN_SEAL_KEY: SEAL,
    AGENTRUN_STORE_URL: PG_URL,
    AGENTRUN_STORE_SCHEMA: schema,
    ...more,
  };
}

/** `node dist/cli.js ...args` on `env`: its stdout and stderr lines kept, stopped (SIGTERM, its exit awaited) by `stop`. */
function cli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  const err = [];
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return {
    child, out, err, exited,
    listen() {
      createInterface({ input: child.stdout }).on("line", (line) => out.push(line));
      createInterface({ input: child.stderr }).on("line", (line) => err.push(line));
      return this;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

/** A schema of the test's own and a server on it (--no-runner, data root `<root>/server`), all stopped and dropped after. */
async function serverOnPostgres(t, more = {}) {
  const schema = await freshSchema();
  const root = await scratch(t);
  const children = [];
  t.after(async () => {
    for (const one of [...children].reverse()) await one.stop();
    assert.deepEqual(await connectionsLeft([schema]), [], "every process on the schema has exited before it is dropped");
    await dropSchema(schema);
  });
  const env = storeEnv(root, schema, { AGENTRUN_TOKEN: TOKEN, ...more });
  const server = cli(["--data", join(root, "server"), "--port", "0", "--faux", FAUX, "--no-runner"], env);
  children.push(server);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(await printed(server.child, /^Open /m))[1]);
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  return { schema, root, api, serverData: join(root, "server"), started: (one) => children.push(one) };
}

test("a Mode 1 run on a disk-free runner is refused in words, never failed by it: the runner claims nothing, the server refuses the launch while only that runner is there, and a runner on the server's data directory takes the run and completes it", { ...postgresOnly("a server and a runner on one Postgres"), timeout: 180_000 }, async (t) => {
  const { schema, root, api, serverData, started } = await serverOnPostgres(t);
  assert.ok(existsSync(join(serverData, DATA_ROOT_FILE)), "the server keeps its data root's id in its data root");

  // The disk-free runner: its own data directory, the same store.
  const ownData = join(root, "runner-own");
  const own = cli(["runner", "--data", ownData, "--faux", FAUX, "--name", "runner-own"], storeEnv(root, schema)).listen();
  started(own);
  await until(async () => own.err.some((line) => line.includes("claims nothing")), "the disk-free runner says it claims nothing", 30_000);
  const said = own.err.find((line) => line.includes("claims nothing"));
  assert.ok(said.includes(DISK_FREE_MODE_1), `in the words that say why and what to do: ${said}`);

  assert.equal((await api("POST", "/agents", agent("plain", { place: { mode: "runner" } }))).status, 201);
  // Its words reach the server through its presence row: a launch is refused in them while it is the only runner.
  let refused;
  await until(async () => {
    refused = await api("POST", "/agents/plain/runs", { input: { content: "Say hello." } });
    return refused.status !== 202;
  }, "the server refuses the launch in the runner's words", 30_000);
  assert.equal(refused.body.error?.code, "runner_refused", JSON.stringify(refused.body));
  assert.ok(refused.body.error.message.includes(DISK_FREE_MODE_1), `the runner's words: ${refused.body.error.message}`);

  // A runner on the server's data directory: runs are taken again, and that runner completes the run. The disk-free runner
  // never claims it.
  const shared = cli(["runner", "--data", serverData, "--faux", FAUX, "--name", "runner-shared"], storeEnv(root, schema)).listen();
  started(shared);
  await until(async () => shared.out.some((line) => /^Runner runner-shared ready: store postgres/.test(line)), "the shared runner is ready", 60_000);
  let run;
  await until(async () => {
    run = await api("POST", "/agents/plain/runs", { input: { content: "Say hello." } });
    return run.status === 202;
  }, "a launch is taken once a runner that can serve it is there", 30_000);
  const { last } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", `${shared.err.join("\n")}\n${own.err.join("\n")}`);
  assert.ok(shared.out.some((line) => line.startsWith(`Runner runner-shared claimed ${run.body.run_id} `)), `the runner on the server's disk ran it: ${shared.out.join("\n")}`);
  assert.ok(!own.out.some((line) => line.includes("claimed")), `the disk-free runner claimed nothing: ${own.out.join("\n")}`);
  assert.ok(!existsSync(join(ownData, "disk")), "and holds no run's folder");
});

test("a server and a disk-free runner on one Postgres, with separate data directories, complete a Mode 2 run through the API: its folder on Archil, the runner's data directory holding only its own", { ...postgresOnly("a server and a runner on one Postgres"), timeout: 180_000 }, async (t) => {
  const { schema, root, api, started } = await serverOnPostgres(t, { ARCHIL_API_KEY: FAKE_ARCHIL });
  const store = await openPostgresStore({ url: PG_URL, schema, role: "runner" });
  started({ stop: () => store.close() });
  await saveArchilSettings(store, { region: REGION, s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });

  // The runner: startRunnerProcess on a data directory of its own, the store's URL and the seal key handed to it, its
  // claim's Archil the fake disk and control plane (the deps' seams, as support.mjs's in-process runner gives them).
  const ownData = join(root, "runner-own");
  const env = { ...storeEnv(root, schema), ARCHIL_API_KEY: FAKE_ARCHIL, [FAUX_ENV]: FAUX };
  const disk = new FakeArchilDisk();
  const control = archilControlFetch({ region: REGION });
  const lines = [];
  const runner = await startRunnerProcess({
    dataDir: ownData, name: "runner-own", env, storeUrl: PG_URL, warn: (line) => void lines.push(line),
    onEvent: (event) => void lines.push(JSON.stringify(event)),
    createLoop: ofStore((opened, sealKey) => {
      const computers = runnerComputers(opened, env, sealKey);
      const deps = { env, data: ownData, journal: (claim) => opened.journal(claim), store: opened, sealKey, routeOf, computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps, makeArchilDisk: () => disk, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch } };
      return { createLoop: dispatchRunner(deps), computers: computers.computerDeps, env };
    }),
  });
  // Closed before the schema goes, with the server (serverOnPostgres stops what it is handed, last first).
  started({ stop: () => runner.close() });
  assert.equal(await diskFreeRefusal(store, ownData, env, "postgres"), undefined, "in Mode 2 a disk-free runner may claim");
  assert.notEqual(await store.settings.get(DATA_ROOT_KEY), null, "the server said its data root");

  assert.equal((await api("POST", "/agents", agent("plain", { place: { mode: "runner" } }))).status, 201);
  const run = await api("POST", "/agents/plain/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", lines.join("\n"));
  assert.ok(lines.some((line) => line.includes('"type":"claimed"') && line.includes(run.body.run_id)), `the disk-free runner ran it: ${lines.join("\n")}`);
  assert.ok(!lines.some((line) => line.includes("claims nothing") || line.includes('"refusing"')), `it was never refused: ${lines.join("\n")}`);
  // Its data directory holds what is the runner's own (its heartbeat, its scratch), never a run's folder, which is on the
  // run's Archil disk.
  assert.ok(!existsSync(join(ownData, "disk")), `no run's folder on the runner's disk: ${readdirSync(ownData).join(", ")}`);
  assert.ok(!existsSync(join(ownData, DATA_ROOT_FILE)), "and no data root id of the server's");
});
