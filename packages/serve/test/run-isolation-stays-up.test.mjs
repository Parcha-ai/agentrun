// A runner whose run isolation is refused (run-child-host.ts runIsolationOf: a helper that cannot switch or cannot be
// started, or an AGENTRUN_RUN_USER it does not know) says why and stays up, claiming nothing, in both of the image's
// shapes: the `runner` subcommand (server-and-runner's second process, where an exit stops the container) and a server
// with its runner in its own process (where it serves with no runner). A platform that restarts a stopped container
// (Render, Railway) would otherwise loop on it. SIGTERM ends either, exit 0. The refusal is driven by an
// AGENTRUN_RUN_USER this runner does not know, the one refusal a host without the image's helper reaches.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
const TOKEN = "isolation-up-token-0123456789abcdef";

/** `node dist/cli.js ...args` in an environment of its own (no NODE_TEST_CONTEXT, no AGENTRUN_* from this shell), what it
 *  printed, and its exit; killed with the test. */
function cli(t, args, extra) {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-isolation-up-"));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), AGENTRUN_TELEMETRY: "0", AGENTRUN_SEAL_KEY: SEAL, ...extra };
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
  return { child, said, exited, home };
}

/** Waits until `said.err` matches `pattern` or the process exits, within `ms`. */
async function errLine(proc, pattern, ms = 30_000) {
  const end = Date.now() + ms;
  while (!pattern.test(proc.said.err) && proc.child.exitCode === null && Date.now() < end) await sleep(50);
  assert.match(proc.said.err, pattern, `the refusal on stderr: ${JSON.stringify(proc.said)}`);
}

/** How many times `pattern` is in `text`. */
const times = (text, pattern) => (text.match(new RegExp(pattern.source, "g")) ?? []).length;

test("the runner subcommand with its isolation refused says why and stays up, claiming nothing, until SIGTERM ends it with exit 0", { timeout: 60_000 }, async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-isolation-up-runner-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const runner = cli(t, ["runner", "--data", data, "--name", "refused-1"], { AGENTRUN_RUN_USER: "bogus" });
  await errLine(runner, REFUSED);
  await sleep(1_500);
  assert.equal(runner.child.exitCode, null, `the runner is still up: ${JSON.stringify(runner.said)}`);
  assert.equal(times(runner.said.err, REFUSED), 1, "the refusal is said once");
  assert.doesNotMatch(runner.said.out, /^Runner .* ready: /m, "it never says it is ready: it claims nothing");
  // No heartbeat: the server's health and a compose healthcheck read none as a runner serving.
  assert.deepEqual(readdirSync(data).filter((name) => name.endsWith(".alive")), [], "it writes no heartbeat");
  const check = cli(t, ["runner", "--check", "--data", data, "--name", "refused-1"], {});
  assert.equal((await check.exited).code, 1, `runner --check says it is not alive: ${JSON.stringify(check.said)}`);
  runner.child.kill("SIGTERM");
  assert.deepEqual(await runner.exited, { code: 0, signal: null });
});

test("a server with its runner in its own process and the runner's isolation refused says why and serves on with no runner", { timeout: 90_000 }, async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-isolation-up-data-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const server = cli(t, ["--data", data, "--port", "0", "--faux", FAUX], { AGENTRUN_RUN_USER: "bogus", AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN });
  const out = await printed(server.child, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)?.[1]);
  await errLine(server, REFUSED);
  const health = await fetch(`http://127.0.0.1:${port}/v2/health`);
  assert.equal(health.status, 200, "the server answers");
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  const caps = await api("GET", "/capabilities");
  assert.equal(caps.body.run_isolation, "process", JSON.stringify(caps.body.run_isolation));
  // A run is refused in the runner's words, never taken to wait for good (runner-refused.test.mjs has the rest).
  const made = await api("POST", "/agents", agent("waits"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/waits/runs", { input: { content: "Answer." } });
  assert.equal(run.status, 503, JSON.stringify(run.body));
  assert.equal(run.body.error.code, "runner_refused", JSON.stringify(run.body));
  assert.match(run.body.error.message, REFUSED, JSON.stringify(run.body));
  assert.equal(times(server.said.err, REFUSED), 1, `the refusal is said once on stderr: ${server.said.err}`);
  assert.equal(server.child.exitCode, null, `the server is still up: ${JSON.stringify(server.said)}`);
  server.child.kill("SIGTERM");
  assert.equal((await server.exited).code, 0);
});
