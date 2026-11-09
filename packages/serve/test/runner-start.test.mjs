// The runner started as its own process through the server's launcher: `agentrun-serve runner --data D [--loops N]`, the
// same bin and Node as the server, its secrets over the launcher's pipe. Each case spawns the launcher as a real child
// (no test runner context in its environment) and drives it by its own lines, never a sleep:
//   - one ready line once it can claim: `Runner <name> ready: store sqlite schema v<N>, <N> loops`;
//   - exit 2 on bad arguments (runnerArgs' words), 3 on a store the server has not set up (SchemaVersionUnknown), 0 on
//     SIGTERM after closing;
//   - each option also as `--option=value` (the bin hands a data directory that starts with "-" as `--data=<dir>`), an
//     empty value refused in words;
//   - AGENTRUN_RUNNER_NAME names it, in its lines and in the runs it claims;
//   - SIGTERM hands a held run back at once, for another runner to claim;
//   - `--check` passes while its heartbeat file (runner-<name>.alive under --data) is younger than twice its renew
//     interval, and fails in words when it is not;
//   - a run's agent's bash under the started runner runs on pi's bash tool's own fixed environment (PWD, HOME, LANG,
//     TMPDIR, TERM, PATH), which holds none of the runner's secrets: the store URL with its password (the real test
//     Postgres's, with AGENTRUN_TEST_PG_URL; on SQLite another AGENTRUN_STORE_* value), the seal key, the server's token
//     and API key, the model key. That pins the bash tool's environment, not the runner's strip: the bash never shows
//     what the runner handed its loops;
//   - the runner's strip itself, where its output goes: the run environment it hands its loops (runEnv: a claimed run's
//     model route and computer read it in the runner's own process), and the environment a claimed run's host tools are
//     handed (claim-secrets.ts over runEnv, as the dispatch builds each claim's ToolHost.env), each with none of the
//     runner's own secrets by name or by value, read or listed. A CLI harness's process (codex, claude-agent, opencode)
//     is spawned on its own allowlist (PATH, LANG, TZ and the harness's own names), never on the run environment, so
//     there is nothing of runEnv's in it to pin.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeDocker } from "../../computer/test/fake-docker.mjs";
import { openPostgresStore, openSqliteStore } from "../dist/store/index.js";
import { until } from "./runner-support.mjs";
import { dropSchema, freshSchema, onPostgres, PG_URL } from "./store-target.mjs";

const { fakeAnthropic } = await import("@parcha/agentrun-harness-claude/testing");
const main = await import("../dist/runner/main.js");
const { SCHEMA_VERSION } = await import("../dist/store/schema.js");

const LAUNCHER = fileURLToPath(new URL("../launcher/agentrun-serve", import.meta.url));
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const READY = /^Runner (\S+) ready: store sqlite schema v(\d+), (\d+) loops$/;
const SEAL = Buffer.alloc(32, 5).toString("base64");
/** The ready line of a runner on `kind`'s store. */
const READY_ON = (kind) => new RegExp(`^Runner (\\S+) ready: store ${kind} schema v(\\d+), (\\d+) loops$`);
/** Values planted where the runner holds secrets: none may reach a run's own process. The store's own (its URL with its
 *  password) are planted per store by storePlant: a store URL is the live store to a runner, never a dummy. */
const PLANT = {
  AGENTRUN_TOKEN: `planted-token-${"t1".repeat(10)}`,
  AGENTRUN_API_KEY: `planted-apikey-${"a1".repeat(10)}`,
  ANTHROPIC_API_KEY: `planted-model-${"k1".repeat(10)}`,
};
/** The names of the runner's planted secrets (PLANT, the store's own `plant` from storePlant, and the seal key) whose
 *  value is in `text`. */
const plantedIn = (text, plant = {}) => [...Object.entries(PLANT), ...Object.entries(plant), ["AGENTRUN_SEAL_KEY", SEAL]].filter(([, value]) => text.includes(value)).map(([name]) => name);

function scratch(t, name) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A data directory the server set up (`dir`, a new scratch one by default): agent-1 (pi, granted bash) and `runs`
 *  queued, each launched on pi with MODEL. */
async function serverData(t, runs = [], dir = scratch(t, "agentrun-runner-start-")) {
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["bash"] } });
  for (const id of runs) await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: id, place: { mode: "runner" }, harness: "pi", model: MODEL } });
  await server.close();
  return dir;
}

/** The store of a rule-5 case (a runner's secrets reach none of its runs or computers) and the secrets the runner holds
 *  for it, set up by the server: agent-1 with `agent` as its body and `runs` ([id, title, place]) queued on pi with MODEL.
 *  On Postgres (AGENTRUN_TEST_PG_URL): the real test store's URL, its password in it, and a schema of the case's own, which
 *  the runner opens (a store URL is the live store to a runner, never a dummy). On SQLite, the data directory's store and
 *  no store URL (it would switch the store): the schema name, and a password-bearing value under another name the runner
 *  keeps to itself (AGENTRUN_STORE_*), so its strip is still pinned. `open()`: the store as a runner opens it, to read
 *  its rows. One builder for both rule-5 cases. */
async function storePlant(t, { agent = { instructions: "Answer.", tools: ["bash"] }, runs = [] } = {}) {
  const dir = scratch(t, "agentrun-runner-start-");
  const setUp = async (server) => {
    await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: agent });
    for (const [id, title, place] of runs) await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title, place, harness: "pi", model: MODEL } });
    await server.close();
  };
  if (!onPostgres) {
    await setUp(await openSqliteStore({ dataDir: dir, role: "server" }));
    const plant = { AGENTRUN_STORE_SCHEMA: "planted_schema", AGENTRUN_STORE_PASSWORD: `postgres://runner:${"plantedstorepass"}@db.invalid:5432/agentrun` };
    return { dir, kind: "sqlite", plant, open: () => openSqliteStore({ dataDir: dir, role: "runner" }) };
  }
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  await setUp(await openPostgresStore({ url: PG_URL, schema, role: "server" }));
  const plant = { AGENTRUN_STORE_URL: PG_URL, AGENTRUN_STORE_SCHEMA: schema };
  return { dir, kind: "postgres", plant, open: () => openPostgresStore({ url: PG_URL, schema, role: "runner" }) };
}

/** The launcher started as `agentrun-serve runner ...args`, its environment built whole (no NODE_TEST_CONTEXT from this
 *  test runner), in `cwd` (this process's by default): its lines on stdout and stderr, and its exit. */
function runnerChild(t, args, extra = {}, { cwd } = {}) {
  const config = scratch(t, "agentrun-runner-config-");
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: config,
    XDG_CONFIG_HOME: config,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    AGENTRUN_SEAL_KEY: SEAL,
    ...extra,
  };
  const child = spawn("sh", [LAUNCHER, "runner", ...args], { env, stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
  const out = [];
  const err = [];
  let notify = () => {};
  createInterface({ input: child.stdout }).on("line", (line) => (out.push(line), notify()));
  createInterface({ input: child.stderr }).on("line", (line) => (err.push(line), notify()));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  /** The first stdout line matching `pattern`, within `ms`. */
  const line = (pattern, ms = 30_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no line ${pattern} within ${ms} ms: ${JSON.stringify({ out, err })}`)), ms);
    const look = () => {
      const found = out.find((one) => pattern.test(one));
      if (found) {
        clearTimeout(timer);
        notify = () => {};
        resolve(found);
      }
    };
    notify = look;
    look();
    exited.then(() => look());
  });
  return { child, out, err, exited, line };
}

test("started by its launcher with a store URL that holds a database password, the runner's own environment holds neither the URL nor its name, and its store opens", async (t) => {
  const dir = await serverData(t);
  const child = runnerChild(t, ["--data", dir], { AGENTRUN_STORE_URL: PLANT.AGENTRUN_STORE_URL, AGENTRUN_RUNNER_NAME: "runner-custody" });
  await child.line(READY);
  // The launcher execs the runner in its own process: its pid is the runner's.
  const environ = readFileSync(`/proc/${child.child.pid}/environ`, "utf8");
  assert.ok(environ.includes("AGENTRUN_RUNNER_NAME=runner-custody"), "the runner's own environment is read");
  assert.ok(!environ.includes("plantedstorepass"), "no database password in the runner's environment");
  assert.ok(!environ.split("\0").some((entry) => entry.startsWith("AGENTRUN_STORE_URL=")), "no store URL in the runner's environment");
  child.child.kill("SIGTERM");
  assert.deepEqual(await child.exited, { code: 0, signal: null });
});

test("bad arguments: the runner exits 2 in runnerArgs' words, and claims nothing", async (t) => {
  const none = runnerChild(t, []);
  assert.deepEqual(await none.exited, { code: 2, signal: null });
  assert.match(none.err.join("\n"), /a runner needs its data directory: --data D/);
  const loops = runnerChild(t, ["--data", "/nowhere", "--loops", "0"]);
  assert.deepEqual(await loops.exited, { code: 2, signal: null });
  assert.match(loops.err.join("\n"), /--loops is a whole number of runs above zero, not "0"/);
});

test("the equals form: `runner --data=-odd-dir --loops=2 --name=runner-eq` opens that data directory (a name that starts with a dash) under those loops and that name", async (t) => {
  const parent = scratch(t, "agentrun-runner-eq-");
  const dir = join(parent, "-odd-dir");
  mkdirSync(dir);
  await serverData(t, [], dir);
  const child = runnerChild(t, ["--data=-odd-dir", "--loops=2", "--name=runner-eq"], {}, { cwd: parent });
  // Ready only on the store the server set up there: an unset directory exits 3, an argument not taken exits 2.
  const first = await Promise.race([child.line(READY), child.exited.then((exit) => ({ exit }))]);
  assert.equal(typeof first, "string", `the runner said it was ready, not ${JSON.stringify({ first, err: child.err })}`);
  assert.deepEqual(first.match(READY).slice(1), ["runner-eq", String(SCHEMA_VERSION), "2"]);
  child.child.kill("SIGTERM");
  assert.deepEqual(await child.exited, { code: 0, signal: null });
});

test("the equals form with nothing after it: `runner --data=` is refused, exit 2, in words", async (t) => {
  const child = runnerChild(t, ["--data="]);
  assert.deepEqual(await child.exited, { code: 2, signal: null });
  assert.match(child.err.join("\n"), /--data needs a value/);
});

test("a data directory the server has not set up: the runner exits 3, saying so", async (t) => {
  const dir = scratch(t, "agentrun-runner-unset-");
  const child = runnerChild(t, ["--data", dir]);
  assert.deepEqual(await child.exited, { code: 3, signal: null });
  assert.match(child.err.join("\n"), /not set up yet: start the server on this data directory first/);
});

test("on the server's store the runner says it is ready in one line, claims nothing with nothing queued, and SIGTERM closes it with exit 0", async (t) => {
  const dir = await serverData(t);
  const child = runnerChild(t, ["--data", dir, "--loops", "3"], { AGENTRUN_RUNNER_NAME: "runner-solo" });
  const ready = (await child.line(READY)).match(READY);
  assert.deepEqual(ready.slice(1), ["runner-solo", String(SCHEMA_VERSION), "3"]);
  child.child.kill("SIGTERM");
  assert.deepEqual(await child.exited, { code: 0, signal: null });
});

test("two runners on one store claim under their own names; SIGTERM hands the held run back at once, and a third runner claims it", async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ hold: new Promise(() => {}), then: { text: "never" } }) });
  t.after(() => fake.close());
  const dir = await serverData(t, ["run-1", "run-2"]);
  const model = { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: PLANT.ANTHROPIC_API_KEY };
  const read = async () => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    try {
      return { "run-1": (await store.runs.get("run-1")).runner, "run-2": (await store.runs.get("run-2")).runner };
    } finally {
      await store.close();
    }
  };
  const a = runnerChild(t, ["--data", dir, "--loops", "1"], { ...model, AGENTRUN_RUNNER_NAME: "runner-a" });
  await a.line(READY);
  await until(async () => Object.values(await read()).includes("runner-a"), "runner-a holds a run", 30_000);
  const b = runnerChild(t, ["--data", dir, "--loops", "1"], { ...model, AGENTRUN_RUNNER_NAME: "runner-b" });
  await b.line(READY);
  await until(async () => new Set(Object.values(await read())).size === 2 && !Object.values(await read()).includes(null), "each runner holds one run", 30_000);
  const held = await read();
  assert.deepEqual(new Set(Object.values(held)), new Set(["runner-a", "runner-b"]), `each run claimed under its runner's name: ${JSON.stringify(held)}`);
  const ofA = Object.keys(held).find((id) => held[id] === "runner-a");
  a.child.kill("SIGTERM");
  assert.deepEqual(await a.exited, { code: 0, signal: null }, "runner-a closed on SIGTERM");
  assert.equal((await read())[ofA], null, "its run was handed back as it closed, not left to its lease");
  const c = runnerChild(t, ["--data", dir, "--loops", "1"], { ...model, AGENTRUN_RUNNER_NAME: "runner-c" });
  await c.line(READY);
  await until(async () => (await read())[ofA] === "runner-c", "runner-c claims the run runner-a handed back", 30_000);
});

test("--check: a running runner's heartbeat passes; a name that never ran fails in words", async (t) => {
  const dir = await serverData(t);
  const child = runnerChild(t, ["--data", dir], { AGENTRUN_RUNNER_NAME: "runner-beat" });
  await child.line(READY);
  const alive = runnerChild(t, ["--check", "--data", dir, "--name", "runner-beat"]);
  assert.deepEqual(await alive.exited, { code: 0, signal: null }, JSON.stringify(alive.err));
  const never = runnerChild(t, ["--check", "--data", dir, "--name", "runner-never"]);
  assert.equal((await never.exited).code, 1);
  assert.match(never.err.join("\n"), /runner-never has no heartbeat/);
});

test("the runner says ready only once its stop signals are handled: a SIGTERM sent on reading the line always closes it", async () => {
  // In this process, on a signal no one else listens to (SIGWINCH: not SIGUSR2, which a test runner's --report-on-signal
  // answers with a report file): the ready callback must find the handler already installed. Emitted, never sent.
  const before = process.listenerCount("SIGWINCH");
  let handledAtReady = -1;
  let closed = false;
  const running = main.runUntilSignalled({ close: async () => void (closed = true) }, ["SIGWINCH"], () => {
    handledAtReady = process.listenerCount("SIGWINCH") - before;
  });
  assert.equal(handledAtReady, 1, "the handler was installed before ready was said");
  process.emit("SIGWINCH");
  await running;
  assert.equal(closed, true, "the signal closed it");
  assert.equal(process.listenerCount("SIGWINCH"), before, "and its handler is gone");
});

test("the heartbeat check, on an injected clock and file times: younger than twice the renew interval passes, older fails in words", (t) => {
  const dir = scratch(t, "agentrun-runner-beat-");
  const check = (now) => main.checkRunner({ dataDir: dir, name: "runner-x", now: () => now });
  const file = join(dir, "runner-runner-x.alive");
  writeFileSync(file, "");
  const at = Date.parse("2026-11-09T12:00:00Z");
  utimesSync(file, at / 1000, at / 1000);
  const twice = 2 * main.RUNNER_RENEW_EVERY_MS;
  assert.deepEqual(check(at + twice - 1_000), { ok: true });
  const stale = check(at + twice + 1_000);
  assert.equal(stale.ok, false);
  assert.match(stale.why, /runner-x's heartbeat is \d+ s old/);
});

// The Docker computer's daemon file, which the computer package's build:daemon makes with Go (CI's build job does; a
// machine with no Go has none). The fake docker never runs it: the provider only copies and binds it.
const DAEMON = fileURLToPath(new URL(`../../computer/dist/computerd-linux-amd64`, import.meta.url));

test("a box-placed run gets its Docker computer through the runner process (the composer's claim): made under its run's labels with its folder mounted, never refused; a runner-placed run beside it gets none", { skip: !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" }, async (t) => {
  // The computer package's fake docker, first on the runner's PATH: it answers run, inspect, exec (the daemon's hello) and
  // rm as the docker CLI does. No Docker is reached. Its daemon answers hello and no file call, so the box-placed run
  // holds once its computer is attached: the case reads what the runner made, then stops the runner.
  const docker = fakeDocker();
  // `docker version` (the provider's create asks Docker its architecture) answers amd64; every other call is the fake's.
  const shim = scratch(t, "agentrun-runner-docker-");
  writeFileSync(join(shim, "docker"), `#!/bin/sh\nif [ "$1" = version ]; then echo amd64; exit 0; fi\nexec ${JSON.stringify(docker.program)} "$@"\n`, { mode: 0o755 });
  const fake = await fakeAnthropic({ reply: () => ({ text: "Done." }) });
  t.after(() => fake.close());
  const { dir, kind, plant, open } = await storePlant(t, {
    agent: { instructions: "Answer." },
    runs: [["run-box", "box", { mode: "sandbox", box: "docker" }], ["run-here", "here", { mode: "runner" }]],
  });
  const child = runnerChild(t, ["--data", dir, "--loops", "2"], {
    PATH: `${shim}:${dirname(process.execPath)}:/usr/bin:/bin`,
    // Every secret the runner holds, planted (the seal key is runnerChild's own; the store's are the plant): none may
    // reach the computer.
    ...PLANT, ...plant, ANTHROPIC_BASE_URL: fake.url, AGENTRUN_RUNNER_NAME: "runner-box",
  });
  await child.line(READY_ON(kind));
  const states = async () => {
    const store = await open();
    try {
      return Object.fromEntries(await Promise.all(["run-box", "run-here"].map(async (id) => [id, await store.runs.get(id)])));
    } finally {
      await store.close();
    }
  };
  // The box-placed run's computer made and attached (its daemon said hello), and the runner-placed run ended.
  const name = () => docker.calls().find((args) => args[0] === "run")?.[docker.calls().find((args) => args[0] === "run").indexOf("--name") + 1];
  let seen;
  await until(async () => {
    const rows = await states();
    seen = { box: [rows["run-box"].state, rows["run-box"].summary], here: [rows["run-here"].state, rows["run-here"].summary] };
    const made = name();
    return made !== undefined && docker.calls().some((args) => args[0] === "exec" && args.includes(made)) && rows["run-here"].state === "ended";
  }, "the box-placed run's computer is attached and the runner-placed run ended", 60_000).catch((error) => assert.fail(`${error.message}: ${JSON.stringify({ seen, docker: docker.calls(), err: child.err.slice(-20) })}`));
  const rows = await states();
  assert.equal(rows["run-box"].state, "running", `the box-placed run runs on its computer, never refused: ${rows["run-box"].summary}`);
  assert.equal(rows["run-here"].state, "ended", `the runner-placed run ran: ${rows["run-here"].summary}`);
  const runs = docker.calls().filter((args) => args[0] === "run");
  assert.equal(runs.length, 1, `one container, the box-placed run's: ${JSON.stringify(docker.calls())}`);
  const flag = (args, name) => args.flatMap((arg, i) => (args[i - 1] === name ? [arg] : []));
  assert.deepEqual(flag(runs[0], "--label").filter((label) => label.startsWith("agentrun.run=") || label.startsWith("agentrun.epoch=")), ["agentrun.run=run-box", "agentrun.epoch=1"], "under its run's labels");
  assert.ok(flag(runs[0], "--mount").some((mount) => mount.includes("/runs/run-box/work,dst=/workspace")), `its run's folder at /workspace: ${flag(runs[0], "--mount").join(" ")}`);
  assert.deepEqual(flag(runs[0], "--network"), ["none"], "no box_allow: no network");
  assert.ok(!runs[0].some((arg) => arg.includes("run-here")), "none for the runner-placed run");
  // Rule 5: a key goes into the server-side provider call alone. Every docker call made for the computer (its argv, so its
  // labels and its --env too) holds none of the runner's secrets.
  assert.deepEqual(plantedIn(JSON.stringify(docker.calls()), plant), [], "the computer's argv, labels and env hold none of the runner's secrets");
  // The runner stops with the run held: handed back for the next claim, whose computer releases this one by its lower
  // epoch (the one fence). A release at the run's end is the composer's (workspace-computer-deps: docker rm).
  child.child.kill("SIGTERM");
  assert.deepEqual(await child.exited, { code: 0, signal: null });
});

test("a run's agent's bash under the started runner runs on pi's bash tool's fixed environment: its `env` shows no store URL, seal key, token, API key or model key", async (t) => {
  let asked = 0;
  const fake = await fakeAnthropic({ reply: () => (++asked === 1 ? { tool: { name: "bash", input: { command: "env" } } } : { text: "Done." }) });
  t.after(() => fake.close());
  const { dir, kind, plant } = await storePlant(t, { runs: [["run-env", "run-env", { mode: "runner" }]] });
  const child = runnerChild(t, ["--data", dir], { ...PLANT, ...plant, ANTHROPIC_BASE_URL: fake.url, AGENTRUN_RUNNER_NAME: "runner-env" });
  await child.line(READY_ON(kind));
  await until(() => fake.messages().length >= 2, "the run's agent ran `env` and sent its output back", 60_000);
  const shown = Object.values(fake.messages()[1].results ?? {}).join("\n");
  assert.match(shown, /^PATH=/m, `the bash ran env: ${shown.slice(0, 200)}`);
  assert.deepEqual(plantedIn(shown, plant), [], "no secret of the runner's in the run's own environment");
  assert.ok(!/AGENTRUN_STORE_|AGENTRUN_SEAL_KEY|AGENTRUN_TOKEN|AGENTRUN_API_KEY/.test(shown), "nor their names");
});

/** The runner's own secrets as it holds them: the store's connection (the real test Postgres's URL, its password in it, on
 *  Postgres), another store name, the seal key and the server's token and API key, beside the model key. */
const RUNNER_OWN = {
  ...PLANT,
  AGENTRUN_STORE_URL: onPostgres ? PG_URL : `postgres://runner:${"plantedstorepass"}@db.invalid:5432/agentrun`,
  AGENTRUN_STORE_SCHEMA: "planted_schema",
  AGENTRUN_SEAL_KEY: SEAL,
};
/** The runner's own names (RUNNER_OWN's but the model key, which a run's model needs) found in `env`, by name (every own
 *  name, enumerable or not: secrets.ts gives a run its pipe's secrets readable by name but not listed) or by value under
 *  any name. */
function runnerOwnIn(env) {
  const names = Object.getOwnPropertyNames(env);
  const values = names.map((name) => String(env[name])).join("\n");
  const own = ["AGENTRUN_STORE_URL", "AGENTRUN_STORE_SCHEMA", "AGENTRUN_SEAL_KEY", "AGENTRUN_TOKEN", "AGENTRUN_API_KEY"];
  return {
    names: names.filter((name) => /^AGENTRUN_STORE_|^AGENTRUN_SEAL_KEY$|^AGENTRUN_TOKEN$|^AGENTRUN_API_KEY$/.test(name)),
    values: own.filter((name) => values.includes(RUNNER_OWN[name])),
  };
}

test("the run environment the runner hands its loops holds none of the runner's own secrets: no store URL or other AGENTRUN_STORE_ name, seal key, token or API key, by name or value, listed or not", () => {
  const env = main.runEnv({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", AGENTRUN_RUNNER_NAME: "runner-env", ...RUNNER_OWN });
  assert.equal(env.LANG, "C.UTF-8", "a name the runner does not keep to itself passes through");
  assert.deepEqual(runnerOwnIn(env), { names: [], values: [] }, "none of the runner's own names, nor their values under another name");
});

test("the environment a claimed run's host tools are handed holds none of the runner's own secrets: no store URL or other AGENTRUN_STORE_ name, seal key, token or API key, by name or value, listed or not", async () => {
  // As the dispatch builds each claim's ToolHost.env (runner/adapter-run-spec.ts): claimSecrets over the run environment
  // the runner hands its loops, for a revision whose tools unlock keys (none saved here, so none is added).
  const { claimSecrets } = await import("../dist/runner/claim-secrets.js");
  const runs = main.runEnv({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", AGENTRUN_RUNNER_NAME: "runner-tools", ...RUNNER_OWN });
  const store = { sealedKeys: { get: async () => undefined } };
  const tools = await claimSecrets({ store, sealKey: Buffer.from(SEAL, "base64"), env: runs }, { kind: "agentic", body: { tools: ["bash", "web_search", "monid.run"] } }, {});
  assert.equal(tools.LANG, "C.UTF-8", "the run environment's other names reach the tools");
  assert.deepEqual(runnerOwnIn(tools), { names: [], values: [] }, "none of the runner's own names, nor their values under another name");
});
