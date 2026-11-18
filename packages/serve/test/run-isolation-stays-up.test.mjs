// A runner whose run isolation is refused (run-child-host.ts runIsolationOf: a helper that cannot switch or cannot be
// started, or an AGENTRUN_RUN_USER it does not know) says why and stays up, claiming nothing, in both of the image's
// shapes: the `runner` subcommand (server-and-runner's second process, where an exit stops the container) and a server
// with its runner in its own process (where it serves with no runner). A platform that restarts a stopped container
// (Render, Railway) would otherwise loop on it. SIGTERM ends either, exit 0. The refusal is driven by an
// AGENTRUN_RUN_USER this runner does not know, the one refusal a host without the image's helper reaches.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { printed } from "./support.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAUX = fileURLToPath(new URL("./fixtures/faux-model.mjs", import.meta.url));
const REFUSED = /AGENTRUN_RUN_USER=bogus is not a setting this runner knows/;
const SEAL = Buffer.alloc(32, 7).toString("base64");

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

test("the runner subcommand with its isolation refused says why and stays up, claiming nothing, until SIGTERM ends it with exit 0", { timeout: 60_000 }, async (t) => {
  const runner = cli(t, ["runner", "--data", join(tmpdir(), "agentrun-isolation-up-nowhere")], { AGENTRUN_RUN_USER: "bogus" });
  await errLine(runner, REFUSED);
  await sleep(1_500);
  assert.equal(runner.child.exitCode, null, `the runner is still up: ${JSON.stringify(runner.said)}`);
  assert.doesNotMatch(runner.said.out, /^Runner .* ready: /m, "it never says it is ready: it claims nothing");
  runner.child.kill("SIGTERM");
  assert.deepEqual(await runner.exited, { code: 0, signal: null });
});

test("a server with its runner in its own process and the runner's isolation refused says why and serves on with no runner", { timeout: 90_000 }, async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-isolation-up-data-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const server = cli(t, ["--data", data, "--port", "0", "--faux", FAUX], { AGENTRUN_RUN_USER: "bogus", AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: "isolation-up-token-0123456789abcdef" });
  const out = await printed(server.child, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)?.[1]);
  await errLine(server, REFUSED);
  const health = await fetch(`http://127.0.0.1:${port}/v2/health`);
  assert.equal(health.status, 200, "the server answers");
  assert.equal(server.child.exitCode, null, `the server is still up: ${JSON.stringify(server.said)}`);
  server.child.kill("SIGTERM");
  assert.equal((await server.exited).code, 0);
});
