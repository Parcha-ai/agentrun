// The runner started as its own process through the server's launcher: `agentrun-serve runner --data D [--loops N]`, the
// same bin and Node as the server, its secrets over the launcher's pipe. Each case spawns the launcher as a real child
// (no test runner context in its environment) and drives it by its own lines, never a sleep:
//   - one ready line once it can claim: `Runner <name> ready: store sqlite schema v<N>, <N> loops`;
//   - exit 2 on bad arguments (runnerArgs' words), 3 on a store the server has not set up (SchemaVersionUnknown), 0 on
//     SIGTERM after closing;
//   - AGENTRUN_RUNNER_NAME names it, in its lines and in the runs it claims;
//   - SIGTERM hands a held run back at once, for another runner to claim;
//   - `--check` passes while its heartbeat file (runner-<name>.alive under --data) is younger than twice its renew
//     interval, and fails in words when it is not;
//   - a run's own process environment (what its agent's bash sees) holds none of the runner's secrets: the store URL with
//     its password, the seal key, the server's token and API key, the model key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openSqliteStore } from "../dist/store/index.js";
import { until } from "./runner-support.mjs";

const { fakeAnthropic } = await import("@parcha/agentrun-harness-claude/testing");
const main = await import("../dist/runner/main.js");
const { SCHEMA_VERSION } = await import("../dist/store/schema.js");

const LAUNCHER = fileURLToPath(new URL("../launcher/agentrun-serve", import.meta.url));
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const READY = /^Runner (\S+) ready: store sqlite schema v(\d+), (\d+) loops$/;
const SEAL = Buffer.alloc(32, 5).toString("base64");
/** Values planted where the runner holds secrets: none may reach a run's own process. */
const PLANT = {
  AGENTRUN_STORE_URL: `postgres://runner:${"plantedstorepass"}@db.invalid:5432/agentrun`,
  AGENTRUN_TOKEN: `planted-token-${"t1".repeat(10)}`,
  AGENTRUN_API_KEY: `planted-apikey-${"a1".repeat(10)}`,
  ANTHROPIC_API_KEY: `planted-model-${"k1".repeat(10)}`,
};

function scratch(t, name) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A data directory the server set up: agent-1 (pi, granted bash) and `runs` queued, each launched on pi with MODEL. */
async function serverData(t, runs = []) {
  const dir = scratch(t, "agentrun-runner-start-");
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["bash"] } });
  for (const id of runs) await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: id, place: { mode: "runner" }, harness: "pi", model: MODEL } });
  await server.close();
  return dir;
}

/** The launcher started as `agentrun-serve runner ...args`, its environment built whole (no NODE_TEST_CONTEXT from this
 *  test runner): its lines on stdout and stderr, and its exit. */
function runnerChild(t, args, extra = {}) {
  const config = scratch(t, "agentrun-runner-config-");
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: config,
    XDG_CONFIG_HOME: config,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    AGENTRUN_SEAL_KEY: SEAL,
    ...extra,
  };
  const child = spawn("sh", [LAUNCHER, "runner", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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

test("bad arguments: the runner exits 2 in runnerArgs' words, and claims nothing", async (t) => {
  const none = runnerChild(t, []);
  assert.deepEqual(await none.exited, { code: 2, signal: null });
  assert.match(none.err.join("\n"), /a runner needs its data directory: --data D/);
  const loops = runnerChild(t, ["--data", "/nowhere", "--loops", "0"]);
  assert.deepEqual(await loops.exited, { code: 2, signal: null });
  assert.match(loops.err.join("\n"), /--loops is a whole number of runs above zero, not "0"/);
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
  // In this process, on a signal no one else listens to: the ready callback must find the handler already installed.
  const before = process.listenerCount("SIGUSR2");
  let handledAtReady = -1;
  let closed = false;
  const running = main.runUntilSignalled({ close: async () => void (closed = true) }, ["SIGUSR2"], () => {
    handledAtReady = process.listenerCount("SIGUSR2") - before;
  });
  assert.equal(handledAtReady, 1, "the handler was installed before ready was said");
  process.emit("SIGUSR2");
  await running;
  assert.equal(closed, true, "the signal closed it");
  assert.equal(process.listenerCount("SIGUSR2"), before, "and its handler is gone");
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

test("a box-placed run fails at its claim with computer_unavailable in words, nothing made: the runner process has no computers yet (a stated stopgap)", async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "never asked" }) });
  t.after(() => fake.close());
  const dir = scratch(t, "agentrun-runner-box-");
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-box", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: "box", place: { mode: "sandbox", box: "docker" }, harness: "pi", model: MODEL } });
  await server.close();
  const child = runnerChild(t, ["--data", dir], { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: PLANT.ANTHROPIC_API_KEY, AGENTRUN_RUNNER_NAME: "runner-box" });
  await child.line(READY);
  const row = await until(async () => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    try {
      const now = await store.runs.get("run-box");
      return now.state === "failed" && now;
    } finally {
      await store.close();
    }
  }, "the box-placed run fails", 30_000);
  assert.match(row.summary ?? "", /computer_unavailable/, `in words: ${row.summary}`);
  assert.match(row.summary ?? "", /the runner's place/, "saying the runner runs only the runner's place");
  assert.equal(fake.messages().length, 0, "nothing made: no model request was sent");
});

test("a run's own process under the started runner holds none of the runner's secrets: its agent's bash `env` shows no store URL, seal key, token, API key or model key", async (t) => {
  let asked = 0;
  const fake = await fakeAnthropic({ reply: () => (++asked === 1 ? { tool: { name: "bash", input: { command: "env" } } } : { text: "Done." }) });
  t.after(() => fake.close());
  const dir = await serverData(t, ["run-env"]);
  const child = runnerChild(t, ["--data", dir], { ...PLANT, ANTHROPIC_BASE_URL: fake.url, AGENTRUN_RUNNER_NAME: "runner-env" });
  await child.line(READY);
  await until(() => fake.messages().length >= 2, "the run's agent ran `env` and sent its output back", 60_000);
  const shown = Object.values(fake.messages()[1].results ?? {}).join("\n");
  assert.match(shown, /^PATH=/m, `the bash ran env: ${shown.slice(0, 200)}`);
  const found = [...Object.entries(PLANT), ["AGENTRUN_SEAL_KEY", SEAL]].filter(([, value]) => shown.includes(value)).map(([name]) => name);
  assert.deepEqual(found, [], "no secret of the runner's in the run's own environment");
  assert.ok(!/AGENTRUN_STORE_URL|AGENTRUN_SEAL_KEY|AGENTRUN_TOKEN|AGENTRUN_API_KEY/.test(shown), "nor their names");
});
