// `agentrun-serve runner --check`: the runner's environment contract (runner/runner-check.ts), by name, never by value,
// failing closed. A runner on a disk of its own gets everything from its environment and its store, so a name its
// launcher dropped is said before a run fails on it:
//   - with nothing, the store's URL and the seal key are missing, and it exits 1;
//   - on Postgres, every run-facing name the server held at its start (it keeps their names in the store) must be the
//     runner's too: one the runner lacks is missing; an upstream on loopback must answer (its forwarder), else it is bad;
//     a seal key that is not the store's is bad; with all of them it exits 0;
//   - no value it was given is ever printed: the store URL's password, the seal key, a tool key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { FAUX, printed, scratch } from "./support.mjs";
import { connectionsLeft, dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const { loopbackTarget, runFacing, runFacingNames, checkLines, RUN_ENV_KEY } = await import("../dist/runner/runner-check.js");

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"c".repeat(40)}`;
const SEAL = Buffer.alloc(32, 11).toString("base64");
const OTHER_SEAL = Buffer.alloc(32, 12).toString("base64");
const MONID = `planted-monid-${"m4".repeat(12)}`;
/** Switches a run reads from its runner's environment: how a gateway is sent a model id, and MCP servers on loopback. */
const SWITCHES = { AGENT_MODEL_GATEWAY_IDS: "bare", AGENTRUN_MCP_ALLOW_LOOPBACK: "1" };

/** `node dist/cli.js ...args` on `env`, run to its exit: its code, stdout and stderr. */
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const baseEnv = (root) => ({ PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: process.env.TMPDIR ?? root });

/** A TCP listener on loopback (a forwarder's stand-in): its port, and its close. */
async function listener(t) {
  const server = createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  t.after(close);
  return { port: server.address().port, close };
}

/** The row of `name` in the check's stdout: `<state> <name> <why>`. */
const rowOf = (out, name) => out.split("\n").find((line) => new RegExp(`^\\S+\\s+${name}\\s`).test(line));
const stateOf = (out, name) => rowOf(out, name)?.split(/\s+/)[0];

test("runner --check --env with nothing: the store's URL and the seal key are missing, said by name, and it exits 1", async (t) => {
  const root = await scratch(t);
  const { code, out, err } = await run(["runner", "--check", "--env"], baseEnv(root));
  assert.equal(code, 1, out + err);
  assert.equal(stateOf(out, "AGENTRUN_STORE_URL"), "missing", out);
  assert.equal(stateOf(out, "AGENTRUN_SEAL_KEY"), "missing", out);
  assert.match(out, /^Runner environment: \d+ gaps?: .*AGENTRUN_STORE_URL/m);
  assert.match(err, /AGENTRUN_STORE_URL: /, "each gap on stderr too");
});

test("runner --check --env with a pool size the runner's start refuses: bad, by name, and it exits 1", async (t) => {
  const root = await scratch(t);
  const { code, out, err } = await run(["runner", "--check", "--env", "--data", root], { ...baseEnv(root), AGENTRUN_STORE_POOL_SIZE: "0" });
  assert.equal(code, 1, out + err);
  assert.match(out, /^bad\s+AGENTRUN_STORE_POOL_SIZE\s+the runner's store does not open with it: AGENTRUN_STORE_POOL_SIZE is a whole number/m);
});

test("--env goes with --check, and a heartbeat check needs a name", async (t) => {
  const root = await scratch(t);
  assert.equal((await run(["runner", "--env", "--data", root], baseEnv(root))).code, 2);
  const named = await run(["runner", "--check", "--data", root], baseEnv(root));
  assert.equal(named.code, 2);
  assert.match(named.err, /--check needs the runner's name/);
  assert.equal((await run(["runner", "--check", "--env", "--heartbeat", "--data", root], baseEnv(root))).code, 2);
});

test("runner --check --heartbeat: the heartbeat alone, with no store and no secret: a name that never ran fails in words, and no environment row is printed", async (t) => {
  const root = await scratch(t);
  const { code, out, err } = await run(["runner", "--check", "--heartbeat", "--data", root, "--name", "runner-never"], baseEnv(root));
  assert.equal(code, 1, out + err);
  assert.match(out, /^bad\s+heartbeat\s+runner-never has no heartbeat/m);
  assert.ok(!/AGENTRUN_STORE_URL|AGENTRUN_SEAL_KEY/.test(out), out);
});

test("on Postgres: every run-facing name the server holds must be the runner's, an upstream on loopback must answer, the seal key must be the store's; no value is ever printed", { ...postgresOnly("a server and a runner on one Postgres"), timeout: 120_000 }, async (t) => {
  const schema = await freshSchema();
  const root = await scratch(t);
  const forwarder = await listener(t);
  const upstream = `http://127.0.0.1:${forwarder.port}/v1`;
  const store = { AGENTRUN_STORE_URL: PG_URL, AGENTRUN_STORE_SCHEMA: schema };
  // The server holds a tool key and a model upstream on loopback (a forwarder beside it), and says their names.
  const server = spawn(process.execPath, [CLI, "--data", join(root, "server"), "--port", "0", "--faux", FAUX, "--no-runner"], {
    env: { ...baseEnv(root), ...store, AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN, AGENTRUN_SEAL_KEY: SEAL, MONID_API_KEY: MONID, ANTHROPIC_BASE_URL: upstream, AGENT_MODEL_FAST: "faux-fast", ...SWITCHES },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await exited;
    assert.deepEqual(await connectionsLeft([schema]), [], "every process on the schema has exited");
    await dropSchema(schema);
  });
  await printed(server, /^Open /m);
  const check = (more) => run(["runner", "--check", "--env", "--data", join(root, "runner")], { ...baseEnv(root), ...store, ...more });
  // The store's URL whole and its user:password part (the test database's password alone is a word the lines hold anyway).
  const { username, password } = new URL(PG_URL);
  const planted = [PG_URL, `${username}:${password}@`, SEAL, OTHER_SEAL, MONID];
  const neverPrinted = ({ out, err }) => {
    for (const value of planted) assert.ok(!out.includes(value) && !err.includes(value), "no value given is printed");
  };

  // The runner lacks the tool key and the upstream: both missing, by name.
  const short = await check({ AGENTRUN_SEAL_KEY: SEAL });
  neverPrinted(short);
  assert.equal(short.code, 1, short.out + short.err);
  assert.equal(stateOf(short.out, "AGENTRUN_STORE_URL"), "ok", short.out);
  assert.equal(stateOf(short.out, "AGENTRUN_SEAL_KEY"), "ok", short.out);
  assert.equal(stateOf(short.out, "MONID_API_KEY"), "missing", short.out);
  assert.equal(stateOf(short.out, "ANTHROPIC_BASE_URL"), "missing", short.out);
  assert.equal(stateOf(short.out, "AGENT_MODEL_FAST"), "missing", "a tier's model the server holds is the runner's too");
  for (const name of Object.keys(SWITCHES)) assert.equal(stateOf(short.out, name), "missing", `${name}: a switch the server holds is the runner's too`);
  assert.match(short.err, /MONID_API_KEY: the server holds it/);

  // With both, and the forwarder answering: complete.
  const whole = await check({ AGENTRUN_SEAL_KEY: SEAL, MONID_API_KEY: MONID, ANTHROPIC_BASE_URL: upstream, AGENT_MODEL_FAST: "faux-fast", ...SWITCHES });
  neverPrinted(whole);
  assert.equal(whole.code, 0, whole.out + whole.err);
  assert.equal(stateOf(whole.out, "MONID_API_KEY"), "ok", whole.out);
  // Its two rows: the server's name held, and its forwarder answering.
  assert.match(whole.out, /^ok\s+ANTHROPIC_BASE_URL\s+on this machine's loopback, and a forwarder answers there$/m);
  assert.match(whole.out, /^Runner environment: complete/m);
  // A pool size the runner's own start refuses fails the check too, though the check opens its store with a pool of one.
  const pooled = await check({ AGENTRUN_SEAL_KEY: SEAL, MONID_API_KEY: MONID, ANTHROPIC_BASE_URL: upstream, AGENT_MODEL_FAST: "faux-fast", ...SWITCHES, AGENTRUN_STORE_POOL_SIZE: "0" });
  neverPrinted(pooled);
  assert.equal(pooled.code, 1, pooled.out + pooled.err);
  assert.equal(stateOf(pooled.out, "AGENTRUN_STORE_POOL_SIZE"), "bad", pooled.out);
  assert.match(pooled.out, /^Runner environment: 1 gap: AGENTRUN_STORE_POOL_SIZE$/m);
  // The server's own token on a runner is warned of, and fails nothing.
  const tokened = await check({ AGENTRUN_SEAL_KEY: SEAL, MONID_API_KEY: MONID, ANTHROPIC_BASE_URL: upstream, AGENT_MODEL_FAST: "faux-fast", ...SWITCHES, AGENTRUN_TOKEN: TOKEN });
  assert.equal(tokened.code, 0, tokened.out);
  assert.equal(stateOf(tokened.out, "AGENTRUN_TOKEN"), "warn", tokened.out);
  assert.ok(!tokened.out.includes(TOKEN), "nor the token");

  // Harness modules the server says it loads (AGENTRUN_SERVE_HARNESS_MODULES; its start loads them, so they are said here
  // straight into its names): a runner with none is missing them; one given --harness-module holds them.
  const { openPostgresStore } = await import("../dist/store/index.js");
  const said = await openPostgresStore({ url: PG_URL, schema, role: "runner" });
  const names = (await said.settings.get(RUN_ENV_KEY)).names;
  await said.settings.put(RUN_ENV_KEY, { v: 1, names: [...names, "AGENTRUN_SERVE_HARNESS_MODULES"] });
  const complete = { AGENTRUN_SEAL_KEY: SEAL, MONID_API_KEY: MONID, ANTHROPIC_BASE_URL: upstream, AGENT_MODEL_FAST: "faux-fast", ...SWITCHES };
  const noModules = await check(complete);
  assert.equal(noModules.code, 1, noModules.out);
  assert.equal(stateOf(noModules.out, "AGENTRUN_SERVE_HARNESS_MODULES"), "missing", noModules.out);
  // A module the runner loads (its start and its check load each one): one harness, its runner pi's.
  const module = join(root, "own-harness.mjs");
  const runnerIndex = new URL("../dist/runner/adapters/index.js", import.meta.url).href;
  writeFileSync(module, `import { RUNNER_HARNESSES } from ${JSON.stringify(runnerIndex)};
export const entries = (builtins) => ({ own: { label: "Own", steer: false, runMib: 64, oneAlwaysFits: false, runs: () => true, onWire: () => false,
  model: (env, ref, available) => builtins.pi.model(env, ref, available), priceModel: (_env, model) => model, refusal: async () => undefined,
  runner: { adapter: (launch, extra) => RUNNER_HARNESSES.pi.adapter(launch, extra) } } });\n`);
  const flagged = await run(["runner", "--check", "--env", "--data", join(root, "runner"), "--harness-module", module], { ...baseEnv(root), ...store, ...complete });
  assert.equal(flagged.code, 0, flagged.out + flagged.err);
  assert.equal(stateOf(flagged.out, "AGENTRUN_SERVE_HARNESS_MODULES"), "ok", flagged.out);
  await said.settings.put(RUN_ENV_KEY, { v: 1, names });
  await said.close();

  // Another seal key: bad. A forwarder that does not answer: bad.
  const otherKey = await check({ AGENTRUN_SEAL_KEY: OTHER_SEAL, MONID_API_KEY: MONID, ANTHROPIC_BASE_URL: upstream, AGENT_MODEL_FAST: "faux-fast", ...SWITCHES });
  neverPrinted(otherKey);
  assert.equal(otherKey.code, 1);
  assert.equal(stateOf(otherKey.out, "AGENTRUN_SEAL_KEY"), "bad", otherKey.out);
  await forwarder.close();
  const noForwarder = await check({ AGENTRUN_SEAL_KEY: SEAL, MONID_API_KEY: MONID, ANTHROPIC_BASE_URL: upstream, AGENT_MODEL_FAST: "faux-fast", ...SWITCHES });
  assert.equal(noForwarder.code, 1);
  assert.match(noForwarder.out, /^bad\s+ANTHROPIC_BASE_URL\s+on this machine's loopback, and nothing answers/m);
  assert.match(noForwarder.err, /ANTHROPIC_BASE_URL: on this machine's loopback, and nothing answers there/);

  // A store URL that does not open: bad, and its password never said.
  const wrong = new URL(PG_URL);
  wrong.pathname = "/no_such_database_here";
  const closed = await run(["runner", "--check", "--env"], { ...baseEnv(root), AGENTRUN_STORE_URL: wrong.href, AGENTRUN_STORE_SCHEMA: schema, AGENTRUN_SEAL_KEY: SEAL });
  neverPrinted(closed);
  assert.equal(closed.code, 1);
  assert.equal(stateOf(closed.out, "AGENTRUN_STORE_URL"), "bad", closed.out);
});

test("the names a server says: its run-facing ones alone, never its own secrets, its store or its seal key", () => {
  const env = { MONID_API_KEY: "x", ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", DAYTONA_TARGET: "us", AGENTRUN_ARCHIL_REGION: "r", AGENT_MODEL: "m", AGENT_MODEL_FAST: "f", AGENT_MODEL_STRONG: "s", AGENTRUN_PRIVATE_HOSTS: "none", AGENT_MODEL_GATEWAY_IDS: "bare", AGENTRUN_MCP_ALLOW_LOOPBACK: "1", AGENTRUN_SERVE_HARNESS_MODULES: "@acme/harness", AGENTRUN_TOKEN: "t", AGENTRUN_STORE_URL: "postgres://x", AGENTRUN_SEAL_KEY: "k", AGENTRUN_BASE_URL: "http://a", UNRELATED: "u", EMPTY_API_URL: "" };
  assert.deepEqual(runFacingNames((name) => env[name], Object.keys(env)), ["AGENTRUN_ARCHIL_REGION", "AGENTRUN_MCP_ALLOW_LOOPBACK", "AGENTRUN_PRIVATE_HOSTS", "AGENTRUN_SERVE_HARNESS_MODULES", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_GATEWAY_IDS", "AGENT_MODEL_STRONG", "ANTHROPIC_BASE_URL", "DAYTONA_TARGET", "MONID_API_KEY"]);
  assert.equal(runFacing("AGENTRUN_TOKEN"), false);
  assert.equal(RUN_ENV_KEY, "server.run_env");
  assert.deepEqual(loopbackTarget("http://localhost:4000/v1"), { host: "localhost", port: 4000 });
  assert.deepEqual(loopbackTarget("https://[::1]/"), { host: "::1", port: 443 });
  assert.equal(loopbackTarget("https://api.anthropic.com"), undefined);
  assert.deepEqual(checkLines([{ state: "ok", name: "A", why: "w" }, { state: "missing", name: "B", why: "w" }]).ok, false);
});
