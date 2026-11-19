// A server none of whose runners can claim says so, instead of queueing runs forever: a runner whose run isolation is
// refused (run-child-host.ts runIsolationOf) says it in the store (runner/presence.ts), and while every live runner has
// refused, a run's launch is 503 runner_refused in the runner's words, GET /v2/capabilities' runner_refused holds them,
// GET /v2/health is 200 `degraded` with its runner check `refused`, and a run already queued ends failed with code
// runner_refused. Both of the image's shapes: a runner in a process of its own (the image's server-and-runner, --no-runner
// and `agentrun-serve runner`) and the runner beside the server in its process. A server with --no-runner and no runner
// yet keeps queueing, and a runner that can claim, once it starts, leaves no refusal behind. The refusal is driven by an
// AGENTRUN_RUN_USER this runner does not know, the one refusal a host without the image's helper reaches.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { agent, client, printed } from "./support.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAUX = fileURLToPath(new URL("./fixtures/faux-model.mjs", import.meta.url));
const REFUSED = /AGENTRUN_RUN_USER=bogus is not a setting this runner knows/;
const SEAL = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "runner-refused-token-0123456789abcdef";

/** `node dist/cli.js ...args` in an environment of its own (no NODE_TEST_CONTEXT, no AGENTRUN_* from this shell), what it
 *  printed, and its exit; killed with the test. */
function cli(t, args, extra) {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runner-refused-"));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), AGENTRUN_TELEMETRY: "0", AGENTRUN_SEAL_KEY: SEAL, AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN, ...extra };
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const said = { out: "", err: "" };
  child.stdout.on("data", (chunk) => void (said.out += chunk));
  child.stderr.on("data", (chunk) => void (said.err += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(home, { recursive: true, force: true });
  });
  return { child, said, exited };
}

/** A server on `data` with `args`: its API, once it printed its `Open` line. */
async function server(t, data, args, extra = {}) {
  const proc = cli(t, ["--data", data, "--port", "0", "--faux", FAUX, ...args], extra);
  const out = await printed(proc.child, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)?.[1]);
  return { ...proc, port, api: client(`http://127.0.0.1:${port}/v2`, TOKEN) };
}

/** Stops `proc` with SIGTERM and waits for its exit 0. */
async function stopped(proc) {
  proc.child.kill("SIGTERM");
  assert.equal((await proc.exited).code, 0, `it stops cleanly: ${proc.said.err}`);
}

/** Waits until `pattern` is on `proc`'s `stream` or it exits, within `ms`. */
async function line(proc, stream, pattern, ms = 30_000) {
  const end = Date.now() + ms;
  while (!pattern.test(proc.said[stream]) && proc.child.exitCode === null && Date.now() < end) await sleep(50);
  assert.match(proc.said[stream], pattern, `on its ${stream}: ${JSON.stringify(proc.said)}`);
}

/** `read()` again until `done` holds of it, within `ms`: the last read. */
async function until(read, done, ms = 20_000) {
  const end = Date.now() + ms;
  let last = await read();
  while (!done(last) && Date.now() < end) {
    await sleep(200);
    last = await read();
  }
  return last;
}

/** What a server whose runners all refused answers: the queued run `queued` failed, a launch refused, capabilities and
 *  health saying so. Each is checked whatever the others answer, and every one that does not hold is said at once. */
async function refusedEverywhere(api, port, queued) {
  const failures = [];
  const check = async (what, body) => {
    try {
      await body();
    } catch (error) {
      failures.push(`${what}: ${error.message}`);
    }
  };
  await check("the queued run", async () => {
    const ended = await until(() => api("GET", `/runs/${queued}`), (r) => r.body.status === "failed");
    assert.equal(ended.body.status, "failed", `it ends failed, never waiting: ${JSON.stringify(ended.body.status)}`);
    assert.equal(ended.body.error?.code, "runner_refused", JSON.stringify(ended.body.error));
    assert.match(String(ended.body.error?.message), REFUSED, JSON.stringify(ended.body.error));
  });
  await check("a launch", async () => {
    const launched = await api("POST", "/agents/waits/runs", { input: { content: "Answer." } });
    assert.equal(launched.status, 503, `refused in words: ${JSON.stringify(launched.body)}`);
    assert.equal(launched.body.error.code, "runner_refused", JSON.stringify(launched.body));
    assert.match(launched.body.error.message, REFUSED, JSON.stringify(launched.body));
    assert.equal(launched.body.error.retryable, false, JSON.stringify(launched.body));
  });
  await check("capabilities", async () => {
    const caps = await api("GET", "/capabilities");
    assert.match(String(caps.body.runner_refused), REFUSED, `they say why no runner claims: ${JSON.stringify(caps.body.runner_refused)}`);
  });
  await check("health", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/v2/health`);
    const body = await health.json();
    assert.equal(health.status, 200, `it stays 200, so a platform's check never restarts the service over it: ${JSON.stringify(body)}`);
    assert.equal(body.status, "degraded", JSON.stringify(body));
    assert.equal(body.checks.runner, "refused", JSON.stringify(body));
    assert.match(String(body.runner_refused), REFUSED, JSON.stringify(body));
  });
  assert.deepEqual(failures, [], "every place says no runner here claims");
}

/** What a server answers once a runner that can claim is there: no refusal anywhere, and a launch taken. */
async function claimsAgain(api, port) {
  const caps = await until(() => api("GET", "/capabilities"), (r) => r.body.runner_refused === null);
  assert.equal(caps.body.runner_refused, null, `no stale refusal: ${JSON.stringify(caps.body.runner_refused)}`);
  const health = await (await fetch(`http://127.0.0.1:${port}/v2/health`)).json();
  assert.deepEqual(health, { status: "ok", checks: { store: "ok", disk: "ok" } });
  const launched = await api("POST", "/agents/waits/runs", { input: { content: "Answer." } });
  assert.equal(launched.status, 202, JSON.stringify(launched.body));
}

test("a runner in a process of its own that refuses to claim: launches 503 in its words, capabilities and health say so, the queued run fails; a runner that can claim clears it", { timeout: 150_000 }, async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runner-refused-apart-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const serve = await server(t, data, ["--no-runner"]);
  const { api, port } = serve;
  assert.equal((await api("POST", "/agents", agent("waits"))).status, 201);
  // No runner yet: today's behaviour, a run queues for a runner to come, and nothing says a refusal.
  const queued = await api("POST", "/agents/waits/runs", { input: { content: "Answer." } });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal((await api("GET", "/capabilities")).body.runner_refused ?? null, null);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/v2/health`)).json(), { status: "ok", checks: { store: "ok", disk: "ok" } });
  const refusing = cli(t, ["runner", "--data", data, "--name", "refuses-1"], { AGENTRUN_RUN_USER: "bogus" });
  await line(refusing, "err", REFUSED);
  await refusedEverywhere(api, port, queued.body.run_id);
  assert.equal(refusing.child.exitCode, null, "the refusing runner stays up");
  // Fixed, as a person on a platform fixes it: the runner started again with AGENTRUN_RUN_USER=same.
  await stopped(refusing);
  const claiming = cli(t, ["runner", "--data", data, "--name", "claims-1", "--faux", FAUX], { AGENTRUN_RUN_USER: "same" });
  await line(claiming, "out", /^Runner claims-1 ready: /m);
  await claimsAgain(api, port);
  await stopped(claiming);
  await stopped(serve);
});

test("a runner beside the server that refuses to claim fails the run an earlier start left queued, and refuses launches until a start whose runner can claim", { timeout: 150_000 }, async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runner-refused-beside-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  // A run left queued by a start with no runner.
  const first = await server(t, data, ["--no-runner"]);
  assert.equal((await first.api("POST", "/agents", agent("waits"))).status, 201);
  const queued = await first.api("POST", "/agents/waits/runs", { input: { content: "Answer." } });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  await stopped(first);
  // Started again with its runner beside it, which refuses.
  const refusing = await server(t, data, [], { AGENTRUN_RUN_USER: "bogus" });
  await line(refusing, "err", REFUSED);
  await refusedEverywhere(refusing.api, refusing.port, queued.body.run_id);
  await stopped(refusing);
  // Started again with AGENTRUN_RUN_USER=same: its runner claims, and no refusal of the stop before is left.
  const fixed = await server(t, data, [], { AGENTRUN_RUN_USER: "same" });
  await claimsAgain(fixed.api, fixed.port);
  await stopped(fixed);
});
