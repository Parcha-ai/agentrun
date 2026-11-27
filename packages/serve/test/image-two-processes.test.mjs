// docker/start.sh, the image's command, run here with no Docker: a copy of it beside a stand-in dist/cli.js (a small node
// script that plays the server or the runner by its arguments and writes what it saw to a log). `server-and-runner`
// starts the server with --no-runner and, once the server answers /v2/health, one runner on the same data; both get the
// launcher's secrets byte for byte over pipes of their own; both write to the script's stdout and stderr. One ending
// ends the other and the script exits non-zero; SIGTERM reaches both and the script exits once both have drained. Any
// other command is that one process, run as given.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// start.sh's server binds the port after the test picked it: one below the ephemeral range, so no listen(0) or outbound
// connection of the suite's other files takes it in between.
import { freePort } from "./fixtures/ports.mjs";

const START = fileURLToPath(new URL("../docker/start.sh", import.meta.url));

// The stand-in for dist/cli.js. STUB_LOG: where it writes one line per event. STUB_HEALTH=never: the server never
// answers. STUB_<ROLE>_EXIT=<code>: that role exits on its own with <code> 300 ms after it starts. STUB_<ROLE>_DRAIN_MS:
// how long that role takes to stop after SIGTERM.
const STUB = String.raw`
import { appendFileSync, readSync } from "node:fs";
import { createServer } from "node:http";
const args = process.argv.slice(2);
const role = args[0] === "runner" ? "runner" : "server";
const log = (line) => appendFileSync(process.env.STUB_LOG, role + " " + line + "\n");
const upper = role.toUpperCase();
// Handled before the "up" line: a test that reads it may send SIGTERM at once, as a real server and runner handle it
// before they say they are ready.
process.on("SIGTERM", () => {
  log("term");
  setTimeout(() => {
    log("drained");
    process.exit(0);
  }, Number(process.env["STUB_" + upper + "_DRAIN_MS"] ?? 50));
});
let secrets = "none";
if (process.env.AGENTRUN_SECRETS_FD !== undefined) {
  const length = Number(process.env.AGENTRUN_SECRETS_LEN);
  const bytes = Buffer.alloc(length);
  for (let read = 0; read < length; ) {
    const got = readSync(Number(process.env.AGENTRUN_SECRETS_FD), bytes, read, length - read, null);
    if (got === 0) throw new Error("short secrets");
    read += got;
  }
  secrets = bytes.toString("hex");
}
log("up " + JSON.stringify({ pid: process.pid, ppid: process.ppid, args, secrets }));
process.stdout.write(role + " says on stdout\n");
process.stderr.write(role + " says on stderr\n");
let server;
if (role === "server" && process.env.STUB_HEALTH !== "never") {
  const port = Number(args[args.indexOf("--port") + 1]);
  // Warming for STUB_WARMING_MS (a 503, as listen-first.ts answers while the store opens), then ready (a 200).
  const ready = Date.now() + Number(process.env.STUB_WARMING_MS ?? 0);
  let answered;
  server = createServer((req, res) => {
    if (req.url !== "/v2/health") return res.writeHead(404).end();
    const now = Date.now() < ready ? "warming" : "ready";
    if (answered !== now) (answered = now, log(now));
    res.writeHead(now === "ready" ? 200 : 503).end();
  }).listen(port, "127.0.0.1");
}
const keep = setInterval(() => {}, 1000);
const exit = process.env["STUB_" + upper + "_EXIT"];
if (exit !== undefined) setTimeout(() => { log("exits " + exit); server?.close(); clearInterval(keep); process.exit(Number(exit)); }, 300);
`;

/** The script beside the stand-in, in a scratch directory, and its log. */
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "image-two-processes-"));
  const scripts = [];
  // A test that fails mid-way leaves no script behind: a second SIGTERM ends its processes at once (stop() in start.sh).
  t.after(async () => {
    for (const { child, exited } of scripts) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGTERM");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "docker"));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "docker", "start.sh"), await readFile(START));
  await writeFile(join(dir, "dist", "cli.js"), STUB);
  await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
  return { script: join(dir, "docker", "start.sh"), log: join(dir, "stub.log"), scripts };
}

/** Starts the script with `args`, `secrets` on fd 3 as the launcher hands them, and `env`. */
function start({ script, log, scripts }, args, { secrets, env = {} } = {}) {
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), STUB_LOG: log, ...env };
  if (secrets !== undefined) Object.assign(childEnv, { AGENTRUN_SECRETS_FD: "3", AGENTRUN_SECRETS_LEN: String(secrets.length) });
  const child = spawn("sh", [script, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  if (secrets !== undefined) child.stdio[3].end(secrets);
  const seen = { out: "", err: "" };
  child.stdout.on("data", (chunk) => (seen.out += chunk));
  child.stderr.on("data", (chunk) => (seen.err += chunk));
  // The script can exit before the last of its stdout and stderr is read. "close" waits for both, but the server and
  // runner it starts hold the same pipes, so one left running would hold "close" until the suite's timeout: settle once
  // both have ended, or 2 s after the exit, and a child left over still fails by name.
  const ended = Promise.all([child.stdout, child.stderr].map((stream) => new Promise((resolve) => stream.once("end", resolve))));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    let timer;
    Promise.race([ended, new Promise((done) => (timer = setTimeout(done, 2000)))]).then(() => (clearTimeout(timer), resolve({ code, signal })));
  }));
  scripts.push({ child, exited });
  return { child, seen, exited };
}

/** The log's lines, parsed: [role, event, detail]. */
const lines = (log) => (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((line) => {
  const [role, event, ...rest] = line.split(" ");
  return { role, event, detail: rest.length ? JSON.parse(rest.join(" ")) : undefined };
});

async function until(what, check, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const up = (log, role) => lines(log).find((line) => line.role === role && line.event === "up")?.detail;
const saw = (log, role, event) => lines(log).some((line) => line.role === role && line.event === event);
/** True while `pid` is a live process. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("server-and-runner starts the server with --no-runner, then a runner on its data once it answers; both get the secrets, both write to the script's stdout and stderr, and SIGTERM drains both before the script exits 0", async (t) => {
  const at = await scratch(t);
  const port = await freePort();
  // NUL-separated pairs, as the launcher writes them, with a space, a newline and a non-ASCII byte in a value.
  // The server's own three among them, which the runner is not handed; the seal key, the store's URL and a provider's key
  // it is (and a name that only starts like the token's).
  const secrets = Buffer.from("AGENTRUN_TOKEN=tok-1234567890abcdef1234567890abcdef\0AGENTRUN_SEAL_KEY=c2VhbA==\0OPENAI_API_KEY=a b\ncé\0AGENTRUN_TOKENS=id:tok-abcdef1234567890abcdef1234567890\0AGENTRUN_STORE_URL=postgres://u:p@h/db\0AGENTRUN_API_KEY=api-1234\0AGENTRUN_TOKEN_X=kept\0", "utf8");
  const runnerSecrets = Buffer.from("AGENTRUN_SEAL_KEY=c2VhbA==\0OPENAI_API_KEY=a b\ncé\0AGENTRUN_STORE_URL=postgres://u:p@h/db\0AGENTRUN_TOKEN_X=kept\0", "utf8");
  const options = ["--data", "/data", "--harness-module", "/walk/one harness.mjs", "--listen", "0.0.0.0", "--port", String(port), "--drain-timeout", "6s", "--max-runs", "3", "--faux=/walk/faux.mjs", "--faux-browser", "/walk/browser.mjs", "--harness-module=/walk/two.mjs"];
  const run = start(at, ["server-and-runner", ...options], { secrets, env: { STUB_RUNNER_DRAIN_MS: "700" } });
  const server = await until("the server starts", () => up(at.log, "server"));
  const runner = await until("the runner starts", () => up(at.log, "runner"));
  assert.deepEqual(server.args, [...options, "--no-runner"], "the server takes the options and --no-runner");
  assert.deepEqual(
    runner.args,
    ["runner", "--data", "/data", "--drain-timeout", "6s", "--loops", "3", "--faux", "/walk/faux.mjs", "--faux-browser", "/walk/browser.mjs", "--harness-module", "/walk/one harness.mjs", "--harness-module", "/walk/two.mjs"],
    "the runner takes the server's data, drain, run limit, faux, fake browser and each harness module, in order",
  );
  assert.equal(server.secrets, secrets.toString("hex"), "the server got the launcher's secrets, byte for byte");
  assert.equal(runner.secrets, runnerSecrets.toString("hex"), "the runner got the same bytes less the server's own three, over a pipe of its own");
  assert.notEqual(server.pid, runner.pid);
  assert.ok(alive(server.pid) && alive(runner.pid), "both run");
  await until("both outputs reach the script's", () => ["server", "runner"].every((role) => run.seen.out.includes(`${role} says on stdout`) && run.seen.err.includes(`${role} says on stderr`)));
  run.child.kill("SIGTERM");
  const { code } = await run.exited;
  assert.equal(code, 0, run.seen.err);
  assert.ok(saw(at.log, "server", "term") && saw(at.log, "runner", "term"), "SIGTERM reached both");
  assert.ok(saw(at.log, "server", "drained") && saw(at.log, "runner", "drained"), "the script waited for both to end");
  assert.ok(!alive(server.pid) && !alive(runner.pid), "neither is left");
});

test("a server that answers it is warming (503) gets no runner until it answers ready: a runner never opens a store its server has not opened", async (t) => {
  const at = await scratch(t);
  const port = await freePort();
  const run = start(at, ["server-and-runner", "--data", "/data", "--port", String(port)], { env: { STUB_WARMING_MS: "2500" } });
  await until("the runner starts", () => up(at.log, "runner"));
  const order = lines(at.log).map((line) => `${line.role} ${line.event}`).filter((line) => ["server warming", "server ready", "runner up"].includes(line));
  assert.deepEqual(order, ["server warming", "server ready", "runner up"], "asked while warming, the runner waited for ready");
  run.child.kill("SIGTERM");
  const { code } = await run.exited;
  assert.equal(code, 0, run.seen.err);
});

test("the runner ending on its own stops the server and the script exits 1, even when the runner's own exit was 0", async (t) => {
  const at = await scratch(t);
  const port = await freePort();
  const run = start(at, ["server-and-runner", "--data", "/data", "--port", String(port)], { env: { STUB_RUNNER_EXIT: "0" } });
  const { code } = await run.exited;
  assert.equal(code, 1, run.seen.err);
  assert.ok(saw(at.log, "runner", "exits"), "the runner exited");
  assert.ok(saw(at.log, "server", "term") && saw(at.log, "server", "drained"), "the server got SIGTERM and stopped");
  assert.match(run.seen.err, /the runner exited 0, so the container stops/);
});

test("the server ending on its own stops the runner and the script exits with the server's code", async (t) => {
  const at = await scratch(t);
  const port = await freePort();
  const run = start(at, ["server-and-runner", "--data", "/data", "--port", String(port)], { env: { STUB_SERVER_EXIT: "7", STUB_SERVER_DRAIN_MS: "50" } });
  // The server exits 300 ms after it starts; the runner may or may not have started by then (the health wait).
  const { code } = await run.exited;
  assert.equal(code, 7, run.seen.err);
  if (up(at.log, "runner")) assert.ok(saw(at.log, "runner", "term") && saw(at.log, "runner", "drained"), "a runner that started got SIGTERM and stopped");
  assert.match(run.seen.err, /the server exited 7, so the container stops/);
});

test("a SIGTERM while the server has not answered yet stops the server, starts no runner, and the script exits 0", async (t) => {
  const at = await scratch(t);
  const port = await freePort();
  const run = start(at, ["server-and-runner", "--data", "/data", "--port", String(port)], { env: { STUB_HEALTH: "never" } });
  await until("the server starts", () => up(at.log, "server"));
  run.child.kill("SIGTERM");
  const { code } = await run.exited;
  assert.equal(code, 0, run.seen.err);
  assert.ok(saw(at.log, "server", "drained"), "the server stopped");
  assert.equal(up(at.log, "runner"), undefined, "no runner started");
});

test("any other command is that one process, run as given, the launcher's pipe handed straight on", async (t) => {
  const at = await scratch(t);
  const secrets = Buffer.from("AGENTRUN_SEAL_KEY=k\0", "utf8");
  for (const args of [["runner", "--data", "/data", "--name", "runner-1"], ["--data", "/data", "--port", "7340"], ["server-and-runner", "--data", "/data", "--port", "7340", "--no-runner"]]) {
    await rm(at.log, { force: true });
    const run = start(at, args, { secrets, env: { STUB_RUNNER_EXIT: "0", STUB_SERVER_EXIT: "0", STUB_HEALTH: "never" } });
    const { code } = await run.exited;
    assert.equal(code, 0, run.seen.err);
    const ups = lines(at.log).filter((line) => line.event === "up");
    assert.equal(ups.length, 1, `one process for ${args.join(" ")}`);
    assert.equal(ups[0].detail.pid, run.child.pid, "the script's own process, by exec");
    assert.deepEqual(ups[0].detail.args, args[0] === "server-and-runner" ? args.slice(1) : args);
    assert.equal(ups[0].detail.secrets, secrets.toString("hex"));
  }
});

test("server-and-runner refuses options with no --data or no --port, exit 2, starting nothing", async (t) => {
  const at = await scratch(t);
  for (const [args, why] of [[["--port", "7340"], /needs --data DIR/], [["--data", "/data"], /needs --port N/], [["--data", "/data", "--port", "0"], /needs --port N/]]) {
    const run = start(at, ["server-and-runner", ...args]);
    const { code } = await run.exited;
    assert.equal(code, 2);
    assert.match(run.seen.err, why);
  }
  assert.equal(lines(at.log).length, 0, "nothing started");
});

// A volume the host mounts as root's (Fly, a compose file's bind mount) would otherwise fail deep in the store's setup.
test("a --data directory this user can't write stops server-and-runner in one line naming it, its owner and this uid, before anything starts", { skip: process.getuid?.() === 0 && "root writes anywhere" }, async (t) => {
  const at = await scratch(t);
  const data = join(at.script, "..", "..", "data");
  await mkdir(data, { mode: 0o555 });
  await chmod(data, 0o555); // empty, so scratch's cleanup removes it even if the test stops before the chmod back
  const uid = process.getuid();
  for (const args of [["--data", data, "--port", "7340"], [`--data=${data}`, "--port", "7340", "--no-runner"]]) {
    // A server that started anyway would end at once and take the script with it, so a miss fails here, not in a hang.
    const run = start(at, ["server-and-runner", ...args], { env: { STUB_SERVER_EXIT: "0", STUB_HEALTH: "never" } });
    const { code } = await run.exited;
    assert.equal(code, 1, run.seen.err);
    const said = run.seen.err.trim().split("\n");
    assert.equal(said.length, 1, run.seen.err);
    assert.match(said[0], new RegExp(`^agentrun-serve: ${data} is not writable by uid ${uid}\\b.*owned by uid ${uid} with mode 555\\b`));
  }
  assert.equal(lines(at.log).length, 0, "nothing started");

  // Writable, or not made yet (the server makes it), it starts as before.
  await chmod(data, 0o755);
  for (const dir of [data, join(data, "not-yet")]) {
    const run = start(at, ["server-and-runner", "--data", dir, "--port", "7340", "--no-runner"], { env: { STUB_SERVER_EXIT: "0" } });
    assert.equal((await run.exited).code, 0, run.seen.err);
  }
  assert.equal(lines(at.log).filter((line) => line.event === "up").length, 2);
});
