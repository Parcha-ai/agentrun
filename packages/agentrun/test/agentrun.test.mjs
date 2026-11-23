// `npx @parcha/agentrun`: the bin runs AgentRun Server, its dependency at its exact version, with the arguments it was given,
// its data in ~/.agentrun unless --data names another, and the browser opened unless --no-open; the server picks the port
// and the model a key gives. The bin prints the console's address on one line, and a subcommand goes to the server's own
// CLI. With no model key the server starts and says it has no model, and the console asks for its first password. npm
// exec of the packed package runs this bin.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import * as start from "../lib/start.mjs";
import { onLoopback, openLineUrl, openUrl } from "../lib/start.mjs";
import { chosenPublicUrl, publicUrlOf } from "../lib/public-url.mjs";
import { tailnetHint, tailnetNameOf } from "../lib/tailscale.mjs";
import { removeAtEnd } from "./support.mjs";

const PACKAGE = new URL("..", import.meta.url).pathname;
const BIN = join(PACKAGE, "bin", "agentrun.mjs");
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
const VERSION = MANIFEST.version;
const SERVE_VERSION = JSON.parse(readFileSync(new URL("../../serve/package.json", import.meta.url), "utf8")).version;
/** This command's store, under the fresh home `bare` makes: ~/.agentrun, handed to the server as --data. */
const STORE = (home) => join(home, ".agentrun");
/** The serve suite's fake docker: it never reaches a daemon (packages/serve/test/fixtures/fake-docker.mjs). */
const FAKE_DOCKER = new URL("../../serve/test/fixtures/fake-docker.mjs", import.meta.url).pathname;
/** The server's own default store (agentrun-serve with no --data), which this command never uses. */
const SERVE_STORE = (home) => join(home, ".local", "share", "agentrun", "agents");
const MODEL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENTRUN_TOKEN"];

/** `promise`, or undefined once `ms` pass: a cleanup never waits without a bound. */
const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};
/** Stops a child this test spawned: SIGTERM, then SIGKILL if it has not exited within 10 s. A child not yet reaped keeps
 *  its pid, so the signal reaches this child only. */
async function stopChild(child, exited) {
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (!alive()) return;
  child.kill("SIGTERM");
  if ((await within(exited.then(() => true), 10_000)) || !alive()) return;
  child.kill("SIGKILL");
  await within(exited, 5_000);
}

/** This environment with a fresh home, no model key, no box, and no browser. */
function bare(t) {
  const home = mkdtempSync(join(tmpdir(), "agentrun-npx-"));
  removeAtEnd(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !MODEL_KEYS.includes(name)));
  // AGENTRUN_BOXES=none: the server it starts asks no Docker (on by default when the setting is not set).
  return { home, env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), CI: "1", AGENTRUN_BOXES: "none" } };
}

test("demo: with no model key, the bin starts on a free loopback port and prints one line, the address the server says to open, on stdout, and its boxes line on stderr; the server has no model and the console asks for its first password", { timeout: 120_000 }, async (t) => {
  const { home, env } = bare(t);
  const child = spawn(process.execPath, [BIN], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => stopChild(child, exited));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !/^Boxes: .*\n/m.test(err); i++) {
    assert.ok(i < 1000, `the bin printed its lines: ${out}${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const match = /^AgentRun is running at (http:\/\/127\.0\.0\.1:(\d+))\/\S*\n$/.exec(out);
  assert.match(err, /^Boxes: none is ready, so sandbox agents do not run here\. [^\n]+$/m, "the boxes line is for the person, on stderr");
  assert.ok(match, `one line, the server's address to open, on loopback: ${JSON.stringify(out)}`);
  assert.ok(Number(match[2]) >= 7340, "the server's first free port from its default");
  const base = match[1];
  const health = await fetch(`${base}/v2/health`);
  assert.deepEqual([health.status, (await health.json()).status], [200, "ok"]);
  assert.equal((await (await fetch(`${base}/v2/capabilities`)).json()).models.default, null, "no model: none was given");
  // Until a single-use sign-in link replaces the plain address, the console's first visit sets the owner's password. The
  // session also carries the accounts/secrets surface (owner-auth.test.mjs, the OpenAPI /v2/auth/session body): accounts
  // on, no secret writable yet, its reason sign_in.
  assert.deepEqual(await (await fetch(`${base}/v2/auth/session`)).json(), { accounts: true, password_set: false, signed_in: false, secrets_writable: false, secrets_reason: "sign_in", setup_code: false });
  assert.ok(existsSync(join(STORE(home), ".token")), "the data directory is ~/.agentrun");
  assert.equal(existsSync(SERVE_STORE(home)), false, "no second store");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, err);
  assert.equal(out.split("\n").filter(Boolean).length, 1, "nothing more on stdout");
});

test("with AGENTRUN_BOXES not set and Docker answering (a fake docker first on PATH), the bin says on stderr that the Docker box is on by default; stdout stays the one running line", { timeout: 120_000 }, async (t) => {
  const { env } = bare(t);
  delete env.AGENTRUN_BOXES;
  const dir = mkdtempSync(join(tmpdir(), "agentrun-npx-docker-"));
  removeAtEnd(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "bin", "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_DOCKER}' "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [BIN, "--no-open"], { env: { ...env, PATH: `${join(dir, "bin")}:${env.PATH}`, FAKE_DOCKER_STATE: join(dir, "state") }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => stopChild(child, exited));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !(/^Boxes: .*\n/m.test(err) && /\n$/.test(out)); i++) {
    assert.ok(i < 1000, `the bin printed its boxes line: ${out}${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const said = err.split("\n").filter((line) => start.SAID.test(line));
  assert.match(out, /^AgentRun is running at http:\/\/127\.0\.0\.1:\d+\/\n$/, "stdout is the one running line a script reads");
  assert.match(said[0], /^Boxes: docker \(on by default; set AGENTRUN_BOXES to change\)\./);
  assert.equal(said.length, 1, err);
  child.kill("SIGTERM");
  assert.equal(await exited, 0, err);
});

test("a subcommand is the server's own, on ~/.agentrun: import --dry-run", { timeout: 60_000 }, async (t) => {
  const { home, env } = bare(t);
  const child = spawn(process.execPath, [BIN, "import", "--dry-run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0, out);
  assert.match(out, /0 projects, 0 sessions; nothing was written \(dry run\)/);
  assert.equal(existsSync(join(STORE(home), ".token")), false, "a dry run writes nothing");
  assert.equal(existsSync(SERVE_STORE(home)), false, "nor opens the server's own default store");
  // reset-password says which store it cleared: ~/.agentrun, or the one --data names.
  const reset = (...args) => spawnSync(process.execPath, [BIN, "reset-password", ...args], { env, encoding: "utf8", timeout: 30_000 });
  mkdirSync(STORE(home), { mode: 0o700 });
  const cleared = reset();
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.ok(cleared.stdout.includes(`(${STORE(home)})`), cleared.stdout);
  const other = join(home, "other");
  mkdirSync(other, { mode: 0o700 });
  const named = reset("--data", other);
  assert.equal(named.status, 0, named.stderr);
  assert.ok(named.stdout.includes(`(${other})`), named.stdout);
  assert.equal(existsSync(SERVE_STORE(home)), false, "never the server's own default store");
});

test("npm exec of the packed package runs this package's own agentrun bin", { timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-pack-"));
  removeAtEnd(dir);
  // npm's own settings from the npm that runs this suite (a workspace, a -c command) are not this npm's.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
  const npm = (args) => execFileSync("npm", args, { cwd: dir, encoding: "utf8", env: { ...clean, npm_config_cache: join(dir, "cache"), npm_config_update_notifier: "false" } });
  const tarball = npm(["pack", PACKAGE, "--pack-destination", dir, "--silent"]).trim().split("\n").at(-1);
  // The server it depends on, as a stand-in at the pinned version: offline, npm installs that and no registry copy.
  mkdirSync(join(dir, "serve"));
  writeFileSync(join(dir, "serve", "package.json"), JSON.stringify({ name: "@parcha/agentrun-serve", version: SERVE_VERSION }));
  const serve = npm(["pack", join(dir, "serve"), "--pack-destination", dir, "--silent"]).trim().split("\n").at(-1);
  const out = npm(["exec", "--offline", "--yes", `--package=file:${join(dir, serve)}`, `--package=file:${join(dir, tarball)}`, "--", "agentrun", "--help"]);
  assert.match(out, /^Usage: npx @parcha\/agentrun /);
});

test("the server is this package's one dependency, at the exact version of the server in this repository: npx installs the two together", () => {
  assert.deepEqual(MANIFEST.dependencies, { "@parcha/agentrun-serve": SERVE_VERSION });
  assert.ok(existsSync(new URL("../../serve/launcher/agentrun-serve", import.meta.url)), "the server ships the launcher this runs");
  const installed = () => join("/opt", "app", "node_modules", "@parcha", "agentrun-serve", "package.json");
  assert.equal(start.installedServer(installed), join("/opt", "app", "node_modules", "@parcha", "agentrun-serve", "launcher", "agentrun-serve"));
  assert.equal(start.installedServer(() => { throw new Error("not installed"); }), undefined);
  assert.equal(start.OWN_SPEC, `@parcha/agentrun@${VERSION}`, "what the server is told started it, so its hints name this command");
});

// The command passes its arguments through: the server's CLI picks the port and opens the browser.
// A stand-in server installed beside a copy of this package records what it was started with.
// `mode` is the stub launcher's (0o644: a launcher that can't be run). The command runs in the stub's own folder, so a
// relative --data lands there. `fileBlocks` caps the size of any file the command writes (`ulimit -f`, 512-byte blocks), as
// a full disk or a quota does. `running(child)`, when given, runs once the command has printed its line, before the test
// sends it the SIGTERM.
async function throughStub(t, args, env = {}, { mode = 0o755, fileBlocks, running } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-stub-"));
  removeAtEnd(dir);
  for (const part of ["bin", "lib", "package.json"]) cpSync(join(PACKAGE, part), join(dir, "pkg", part), { recursive: true });
  const serve = join(dir, "pkg", "node_modules", "@parcha", "agentrun-serve");
  mkdirSync(join(serve, "launcher"), { recursive: true });
  writeFileSync(join(serve, "package.json"), JSON.stringify({ name: "@parcha/agentrun-serve", version: SERVE_VERSION }));
  const served = join(dir, "served.json");
  writeFileSync(join(serve, "launcher", "agentrun-serve"), `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(served)}, JSON.stringify({ args: process.argv.slice(2), npx: process.env.AGENTRUN_NPX_PACKAGE, model: process.env.AGENT_MODEL ?? null, public: process.env.AGENTRUN_PUBLIC_URL ?? null, proxies: process.env.AGENTRUN_TRUSTED_PROXIES ?? null, pid: process.pid }));
if (process.argv[2] === "import") process.exit(0);
// STUB_FAIL: print why and exit before any "Open " line; STUB_OPEN: the URL its "Open " line names; STUB_SIGTERM=die: no
// handler, so a SIGTERM ends it by the signal, as a real server's can.
if (process.env.STUB_FAIL) { console.log("listen EADDRINUSE: 127.0.0.1:7340 is in use (stub)"); process.exit(1); }
// STUB_FAIL_STDERR: say why on stderr only (as a lock refusal does) and exit before any line on stdout; STUB_STDERR_LINES
// numbered lines on stderr before it.
if (process.env.STUB_FAIL_STDERR) {
  for (let i = 1; i <= Number(process.env.STUB_STDERR_LINES ?? 0); i++) console.error("stub stderr line " + i);
  console.error("agentrun-serve: another server holds this data root (stub)");
  process.exit(1);
}
// STUB_EXIT: print nothing at all and exit with that code.
if (process.env.STUB_EXIT) process.exit(Number(process.env.STUB_EXIT));
// STUB_KILLED: one line on stdout, then a SIGKILL nobody else sent (as the kernel's out-of-memory killer ends a process).
if (process.env.STUB_KILLED) { console.log("agentrun-serve: opening the store (stub)"); process.kill(process.pid, "SIGKILL"); }
// STUB_CLOSE: close stdout and keep running, never having printed an "Open " line.
if (process.env.STUB_CLOSE) { require("node:fs").closeSync(1); setInterval(() => {}, 1000); }
// STUB_HANG: one line and never an "Open " line; STUB_HANG=deaf ignores a SIGTERM too.
else if (process.env.STUB_HANG) {
  console.log("agentrun-serve: still getting ready (stub)");
  if (process.env.STUB_HANG === "deaf") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
// STUB_STARTING: its "Starting " line at once, as a server that has bound its port says, then its banner that many ms
// later, as one still loading on a slow disk.
} else if (process.env.STUB_STARTING) {
  console.log("Starting http://127.0.0.1:7399/ (warming, stub)");
  setTimeout(() => {
    console.log("agentrun-serve on http://127.0.0.1:7399/v2 (stub)");
    console.log("Open http://127.0.0.1:7399/");
  }, Number(process.env.STUB_STARTING));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  console.log("agentrun-serve on http://127.0.0.1:7399/v2 (stub)");
  // STUB_SETUP: the setup-code line a server with a public URL and no password yet prints.
  if (process.env.STUB_SETUP) console.log("Set up this server: " + process.env.STUB_SETUP);
  console.log("Open " + (process.env.STUB_OPEN || "http://127.0.0.1:7399/"));
  // STUB_STDERR_AFTER: a line on stderr every 50 ms once it has started, as a server's warnings come.
  if (process.env.STUB_STDERR_AFTER) setInterval(() => console.error("agentrun-serve: a warning (stub)"), 50);
  if (process.env.STUB_SIGTERM !== "die") process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`);
  const launcher = join(serve, "launcher", "agentrun-serve");
  chmodSync(launcher, mode);
  const { home, env: base } = bare(t);
  const bin = join(dir, "pkg", "bin", "agentrun.mjs");
  const command = fileBlocks === undefined ? [process.execPath, [bin, ...args]] : ["/bin/sh", ["-c", `ulimit -f ${fileBlocks} && exec "$0" "$@"`, process.execPath, bin, ...args]];
  const child = spawn(...command, { cwd: dir, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  // Both pipes drained: stderr comes on a pipe of its own, so it is read only once the child has closed them.
  const closed = new Promise((resolve) => child.on("close", resolve));
  t.after(() => stopChild(child, exited));
  // A stub the command left running (it died first) is stopped too, while it still runs the stub.
  t.after(() => { if (existsSync(served)) killIf(JSON.parse(readFileSync(served, "utf8")).pid, launcher); });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !out.includes("\n") && child.exitCode === null && i < 300; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (running !== undefined) await running(child);
  child.kill("SIGTERM");
  const code = await exited;
  await closed;
  return { dir, home, launcher, out, err, code, ...(existsSync(served) ? JSON.parse(readFileSync(served, "utf8")) : {}) };
}

/** What a start that failed says, from its first line on: the server's own stderr, as it printed it, comes before. */
const failureOf = (err) => err.slice(err.indexOf("AgentRun did not start"));
/** The start log of a start whose store is ~/.agentrun under `home`. */
const startLog = (home) => join(STORE(home), "start.log");

test("with AGENTRUN_PUBLIC_URL it starts and names that address; a stop it forwards ends it with 0; a server that can't start is shown with its own last lines", { timeout: 60_000 }, async (t) => {
  const pub = await throughStub(t, ["--no-open"], { AGENTRUN_PUBLIC_URL: "https://agentrun.example.com", STUB_OPEN: "https://agentrun.example.com/" });
  assert.equal(pub.out, "AgentRun is running at https://agentrun.example.com/\n", pub.err);
  const died = await throughStub(t, ["--no-open"], { STUB_SIGTERM: "die" });
  assert.equal(died.code, 0, `a SIGTERM this command passed on is a clean stop: ${died.err}`);
  const failed = await throughStub(t, ["--no-open"], { STUB_FAIL: "1" });
  assert.equal(failed.code, 1, failed.err);
  assert.match(failed.err, /^AgentRun did not start: the server exited with code 1 before it printed the address to open\.$/m, failed.err);
  assert.match(failureOf(failed.err), /^ {2}stdout, last line:\n {4}listen EADDRINUSE: 127\.0\.0\.1:7340 is in use \(stub\)$/m, failed.err);
  // A server that says why on stderr only: that line comes through as it prints it, and again in the failure.
  const quiet = await throughStub(t, ["--no-open"], { STUB_FAIL_STDERR: "1" });
  assert.equal(quiet.code, 1, quiet.err);
  assert.match(quiet.err, /^agentrun-serve: another server holds this data root \(stub\)$/m, quiet.err);
  assert.match(failureOf(quiet.err), /^ {2}stderr, last line:\n {4}agentrun-serve: another server holds this data root \(stub\)$/m, quiet.err);
  assert.match(failureOf(quiet.err), /^ {2}stdout: nothing$/m, quiet.err);
});

test("a server that prints nothing and exits 3: the bin names the step, the exit code and the start log, kept private in the data folder", { timeout: 60_000 }, async (t) => {
  const run = await throughStub(t, ["--no-open"], { STUB_EXIT: "3" });
  assert.equal(run.code, 3, run.err);
  assert.equal(run.out, "", "stdout stays the one line a script reads on success, and empty on a failure");
  const failure = failureOf(run.err);
  assert.equal(failure, [
    "AgentRun did not start: the server exited with code 3 before it printed the address to open.",
    "  step: wait for the server to print the address to open (at most 60 s)",
    "  exit: code 3",
    "  stderr: nothing",
    "  stdout: nothing",
    `  log: ${startLog(run.home)}`,
    "",
  ].join("\n"), run.err);
  // The log holds everything the server wrote in this start (here nothing) and then the failure itself.
  assert.equal(readFileSync(startLog(run.home), "utf8"), failure);
  assert.equal(statSync(startLog(run.home)).mode & 0o777, 0o600, "the start log is private: the server's banner names its token");
  assert.equal(statSync(STORE(run.home)).mode & 0o777, 0o700, "the data folder is made private, as the server makes it");
  // A start log that can't be kept is no reason not to start; a start that fails says why there is none.
  const spot = mkdtempSync(join(tmpdir(), "agentrun-nolog-"));
  removeAtEnd(spot);
  writeFileSync(join(spot, "file"), "");
  const nolog = await throughStub(t, ["--no-open", "--data", join(spot, "file")], { STUB_EXIT: "3" });
  assert.equal(nolog.code, 3, nolog.err);
  assert.match(failureOf(nolog.err), /^AgentRun did not start: the server exited with code 3 /, nolog.err);
  assert.match(failureOf(nolog.err), /\n {2}log: none \([A-Z]+: [^\n]+\)\n$/, nolog.err);
});

test("a server ended by a SIGKILL nobody here sent, before its Open line: the bin names the signal, and its last stdout lines are said and logged", { timeout: 60_000 }, async (t) => {
  const run = await throughStub(t, ["--no-open"], { STUB_KILLED: "1" });
  assert.equal(run.code, 1, run.err);
  const failure = failureOf(run.err);
  assert.match(failure, /^AgentRun did not start: the server was ended by SIGKILL before it printed the address to open\.$/m, run.err);
  assert.match(failure, /^ {2}exit: signal SIGKILL \(not sent by this command: the system may have run out of memory\)$/m, run.err);
  assert.match(failure, /^ {2}stdout, last line:\n {4}agentrun-serve: opening the store \(stub\)$/m, run.err);
  assert.match(readFileSync(startLog(run.home), "utf8"), /^agentrun-serve: opening the store \(stub\)\nAgentRun did not start: /);
});

test("a server that says why on stderr and exits 1: its stderr comes through as it prints it, its last lines again in the failure, all of it in the log", { timeout: 60_000 }, async (t) => {
  const run = await throughStub(t, ["--no-open"], { STUB_FAIL_STDERR: "1", STUB_STDERR_LINES: "25" });
  assert.equal(run.code, 1, run.err);
  const failure = failureOf(run.err);
  assert.ok(run.err.startsWith("stub stderr line 1\n"), `the server's stderr, live, first: ${run.err}`);
  assert.match(failure, /^AgentRun did not start: the server exited with code 1 before it printed the address to open\.$/m, run.err);
  // The last TAIL_LINES lines: 7 to 25 and the reason.
  const tail = [...Array.from({ length: 19 }, (_, i) => `    stub stderr line ${i + 7}`), "    agentrun-serve: another server holds this data root (stub)"];
  assert.ok(failure.includes(`\n  stderr, last 20 lines:\n${tail.join("\n")}\n  stdout: nothing\n`), run.err);
  assert.ok(!failure.includes("stub stderr line 6\n"), run.err);
  const log = readFileSync(startLog(run.home), "utf8");
  for (let i = 1; i <= 25; i++) assert.ok(log.includes(`stub stderr line ${i}\n`), `line ${i} in the log: ${log}`);
  assert.ok(log.includes("agentrun-serve: another server holds this data root (stub)\n"), log);
});

test("a server that never prints its Open line: past the bound (AGENTRUN_START_TIMEOUT_MS) the bin says it was still running and was stopped", { timeout: 60_000 }, async (t) => {
  const run = await throughStub(t, ["--no-open"], { STUB_HANG: "1", AGENTRUN_START_TIMEOUT_MS: "1000" });
  assert.equal(run.code, 1, run.err);
  const failure = failureOf(run.err);
  assert.match(failure, /^AgentRun did not start: the server was still running after 1 s without printing the address to open, so it was stopped\. AGENTRUN_START_TIMEOUT_MS sets a longer wait, in milliseconds\.$/m, run.err);
  assert.match(failure, /^ {2}step: wait for the server to print the address to open \(at most 1 s\)$/m, run.err);
  assert.match(failure, /^ {2}exit: still running after 1 s; stopped with SIGTERM; then signal SIGTERM$/m, run.err);
  assert.match(failure, /^ {2}stdout, last line:\n {4}agentrun-serve: still getting ready \(stub\)$/m, run.err);
  assert.ok(failure.endsWith(`\n  log: ${startLog(run.home)}\n`), run.err);
});

test("a server that says Starting is listening: the bound no longer applies, the bin names the address on stderr at once, and its stdout is the Open line's URL once it is ready", { timeout: 60_000 }, async (t) => {
  const run = await throughStub(t, ["--no-open"], { STUB_STARTING: "2500", AGENTRUN_START_TIMEOUT_MS: "1000" });
  assert.equal(run.code, 0, run.err);
  assert.equal(run.out, "AgentRun is running at http://127.0.0.1:7399/\n", run.err);
  assert.match(run.err, /^AgentRun is starting at http:\/\/127\.0\.0\.1:7399\/: it listens there now, and opens once its store is ready\.$/m, run.err);
  assert.doesNotMatch(run.err, /did not start/, run.err);
});

test("a server that never prints its Open line and ignores the SIGTERM is SIGKILLed after the grace, and the bin says both", { timeout: 60_000 }, async (t) => {
  const run = await throughStub(t, ["--no-open"], { STUB_HANG: "deaf", AGENTRUN_START_TIMEOUT_MS: "1000" });
  assert.equal(run.code, 1, run.err);
  assert.match(failureOf(run.err), /^ {2}exit: still running after 1 s; stopped with SIGTERM, then SIGKILL 10 s later; then signal SIGKILL$/m, run.err);
});

test("a server that closes its stdout and keeps running, with no Open line: the bin says so and stops it", { timeout: 60_000 }, async (t) => {
  const run = await throughStub(t, ["--no-open"], { STUB_CLOSE: "1" });
  assert.equal(run.code, 1, run.err);
  const failure = failureOf(run.err);
  assert.match(failure, /^AgentRun did not start: the server closed its output without printing the address to open, so it was stopped\.$/m, run.err);
  assert.match(failure, /^ {2}exit: its output closed while it ran; stopped with SIGTERM; then signal SIGTERM$/m, run.err);
});

test("a reader of the command's stderr that goes away once it has started (a `| head`, a closed log) never ends it: the server's later stderr is dropped, and a SIGTERM to the command still stops the server", { timeout: 60_000 }, async (t) => {
  let after;
  const run = await throughStub(t, ["--no-open"], { STUB_STDERR_AFTER: "1" }, {
    running: async (child) => {
      child.stderr.destroy();
      // The stub writes a stderr line every 50 ms: each would reach the closed pipe.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      after = { code: child.exitCode, signal: child.signalCode };
    },
  });
  assert.equal(run.out, "AgentRun is running at http://127.0.0.1:7399/\n", run.err);
  assert.deepEqual(after, { code: null, signal: null }, "the command is still running with its stderr's reader gone");
  assert.equal(run.code, 0, "the SIGTERM it was then sent is a clean stop");
  assert.ok(await gone(run.pid, run.launcher), "and it stopped the server: none is left running");
});

test("the server's stderr is passed on at the pace this command's stderr is read, every chunk still to the tail and the log; a stderr that fails stops the passing on, never the reading", async () => {
  const source = new PassThrough();
  const written = [];
  let release;
  // A reader that takes nothing until it is let go: each write waits.
  const dest = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { written.push(String(chunk)); release = done; } });
  const tapped = [];
  start.forward(source, dest, (chunk) => tapped.push(String(chunk)));
  for (const chunk of ["one\n", "two\n", "three\n"]) source.write(chunk);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ["one\n"], "one chunk at the reader");
  assert.equal(source.isPaused(), true, "the server's stderr waits for the reader");
  assert.ok(dest.writableLength <= 4, `nothing piles up in this command: ${dest.writableLength} bytes held`);
  assert.deepEqual(tapped, ["one\n"], "the tail and the log take each chunk as it is passed on");
  for (let i = 0; written.length < 3 && i < 10; i++) {
    release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(written, ["one\n", "two\n", "three\n"], "in order once the reader takes them");
  // The reader gone: no more passing on, and the server's stderr is still read (to the tail and the log), so it never
  // blocks on a full pipe.
  dest.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  await new Promise((resolve) => setImmediate(resolve));
  source.write("four\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tapped, ["one\n", "two\n", "three\n", "four\n"]);
  assert.deepEqual(written, ["one\n", "two\n", "three\n"]);
  assert.equal(source.isPaused(), false);
});

test("a start log the disk can't hold all of (a full disk, a quota): the start goes on, and a start that fails says the log is incomplete and why", { timeout: 60_000 }, async (t) => {
  // 100 lines on stderr, about 2 kB, with the command's files capped at 512 bytes: the log takes what fits, then a write
  // fails (EFBIG).
  const run = await throughStub(t, ["--no-open"], { STUB_FAIL_STDERR: "1", STUB_STDERR_LINES: "100" }, { fileBlocks: 1 });
  assert.equal(run.code, 1, run.err);
  const failure = failureOf(run.err);
  assert.match(failure, /^AgentRun did not start: the server exited with code 1 before it printed the address to open\.$/m, run.err);
  assert.match(failure, /^ {2}stderr, last 20 lines:\n/m, run.err);
  const path = startLog(run.home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(failure, new RegExp(`\\n {2}log: ${path} \\(incomplete: EFBIG: [^\\n]+\\)\\n$`), run.err);
  const wrote = [...Array.from({ length: 100 }, (_, i) => `stub stderr line ${i + 1}\n`), "agentrun-serve: another server holds this data root (stub)\n"].join("");
  const log = readFileSync(startLog(run.home), "utf8");
  assert.ok(log.length > 0 && wrote.startsWith(log), `the log holds the server's first bytes, as many as fit: ${log}`);
});

test("a server launcher that can't be run: the start and a server command each say the step and the error, with no stack trace", { timeout: 60_000 }, async (t) => {
  const launcherIn = (dir) => join(dir, "pkg", "node_modules", "@parcha", "agentrun-serve", "launcher", "agentrun-serve");
  const run = await throughStub(t, ["--no-open"], {}, { mode: 0o644 });
  assert.equal(run.code, 1, run.err);
  const launcher = launcherIn(run.dir);
  assert.equal(run.err, [
    `AgentRun did not start: the server could not be started (spawn ${launcher} EACCES).`,
    `  step: start the server (${launcher})`,
    "  exit: it never ran",
    "  stderr: nothing",
    "  stdout: nothing",
    `  log: ${startLog(run.home)}`,
    "",
  ].join("\n"));
  const sub = await throughStub(t, ["import", "--dry-run"], {}, { mode: 0o644 });
  assert.equal(sub.code, 1, sub.err);
  assert.equal(sub.err, [
    `The server's import command failed: it could not be started (spawn ${launcherIn(sub.dir)} EACCES).`,
    `  step: run the server's import command (${launcherIn(sub.dir)})`,
    "  exit: it never ran",
    "",
  ].join("\n"));
});

test("a server command's --help or -h goes to the server, which prints that command's usage; the bin's own usage is for the bin alone", { timeout: 60_000 }, async (t) => {
  const imported = await throughStub(t, ["import", "--help"]);
  assert.deepEqual(imported.args, ["import", "--data", STORE(imported.home), "--help"], imported.out + imported.err);
  assert.doesNotMatch(imported.out, /^Usage: npx @parcha\/agentrun /m, "not the bin's own usage");
  const native = await throughStub(t, ["native", "discover", "-h"]);
  assert.deepEqual(native.args, ["native", "--data", STORE(native.home), "discover", "-h"], native.out + native.err);
  const bin = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.match(bin.stdout, /^Usage: npx @parcha\/agentrun /, "the bin's own --help, with no command, is still its usage");
});

test("the command passes its arguments through to the server, with its store (~/.agentrun unless --data names one) and --open unless --no-open; it picks no port or model of its own", { timeout: 60_000 }, async (t) => {
  const plain = await throughStub(t, [], { ANTHROPIC_API_KEY: "sk-test" });
  assert.deepEqual([plain.args, plain.model, plain.npx], [["--open", "--data", STORE(plain.home)], null, `@parcha/agentrun@${VERSION}`], plain.err);
  assert.equal(plain.out, "AgentRun is running at http://127.0.0.1:7399/\n");
  // A person reads how to stop it and where its data is; stdout stays the one line a script reads.
  assert.match(plain.err, new RegExp(`^Press Ctrl-C to stop it\\. Its data is in ${STORE(plain.home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`, "m"), plain.err);
  // And where the API's bearer token is: the server's own line saying so stays out of this terminal.
  assert.match(plain.err, new RegExp(`^The API token is in ${STORE(plain.home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.token\\.$`, "m"), plain.err);
  const tokened = await throughStub(t, ["--no-open"], { AGENTRUN_TOKEN: "t".repeat(40) });
  assert.match(tokened.err, /^The API token is the AGENTRUN_TOKEN this command was started with\.$/m, tokened.err);
  assert.equal(plain.code, 0, plain.err);
  // Relative data folders, in the stub's own folder: the command makes the folder it keeps its start log in.
  const given = await throughStub(t, ["--no-open", "--port", "7400", "--data", "srv/agents"]);
  assert.deepEqual(given.args, ["--data", "srv/agents", "--port", "7400"], given.err);
  assert.ok(existsSync(join(given.dir, "srv", "agents", "start.log")), "the start log is in the folder --data names");
  // --data=<dir> is the same option, and the last --data wins, as the server reads them: the server gets one --data, and
  // the hint names the directory it uses.
  const equals = await throughStub(t, ["--no-open", "--data=srv/agents"]);
  assert.deepEqual(equals.args, ["--data", "srv/agents"], equals.err);
  assert.match(equals.err, /^Press Ctrl-C to stop it\. Its data is in srv\/agents\.$/m, equals.err);
  const twice = await throughStub(t, ["--no-open", "--data", "srv/first", "--data=srv/second"]);
  assert.deepEqual(twice.args, ["--data", "srv/second"], twice.err);
  assert.match(twice.err, /^Press Ctrl-C to stop it\. Its data is in srv\/second\.$/m, twice.err);
  assert.equal(existsSync(join(twice.dir, "srv", "first")), false, "only the folder the server uses");
  // A directory whose name starts with a dash keeps the equals form: the server's parser reads "--data -store" as a
  // missing value.
  const dash = await throughStub(t, ["--no-open", "--data=-store"]);
  assert.deepEqual(dash.args, ["--data=-store"], dash.err);
  assert.match(dash.err, /^Press Ctrl-C to stop it\. Its data is in -store\.$/m, dash.err);
  // A server flag's value is no command: --listen ADDR starts the server.
  const listen = await throughStub(t, ["--no-open", "--listen", "0.0.0.0"]);
  assert.deepEqual(listen.args, ["--data", STORE(listen.home), "--listen", "0.0.0.0"], listen.err);
  const sub = await throughStub(t, ["--data", "/srv/agents", "import", "--dry-run"]);
  assert.deepEqual(sub.args, ["import", "--data", "/srv/agents", "--dry-run"], "a subcommand first, on the same data directory");
  const own = await throughStub(t, ["import", "--dry-run"]);
  assert.deepEqual(own.args, ["import", "--data", STORE(own.home), "--dry-run"], "a subcommand on ~/.agentrun");
});

test("with the server missing from beside it, the command says so in one line and exits 1", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-alone-"));
  removeAtEnd(dir);
  for (const part of ["bin", "lib", "package.json"]) cpSync(join(PACKAGE, part), join(dir, part), { recursive: true });
  const run = spawnSync(process.execPath, [join(dir, "bin", "agentrun.mjs"), "--no-open"], { encoding: "utf8", env: bare(t).env });
  assert.deepEqual([run.status, run.stdout, run.stderr], [1, "", `AgentRun's server (@parcha/agentrun-serve) is not installed beside this command; run it as npx @parcha/agentrun@${VERSION}.\n`]);
});

// A stub server: its output as the server prints it, a line at a time, then it waits. The command takes the URL of the first
// "Open " line, whatever it is: the plain address today, a single-use sign-in link once the server prints that instead.
const stub = (lines, { exit = false } = {}) => spawn(process.execPath, ["-e", `const lines = ${JSON.stringify(lines)}; let i = 0; const next = () => { if (i < lines.length) { process.stdout.write(lines[i++]); setTimeout(next, 20); } else if (${exit}) process.exit(0); else setInterval(() => {}, 1000); }; next();`], { stdio: ["ignore", "pipe", "inherit"] });

test("the address to open is the URL on the server's first \"Open \" line, however its output is cut; a later Open line, and the lines around it, change nothing", async (t) => {
  const plain = stub(["agentrun-serve on http://127.0.0.1:7341/v2 (agent store in /tmp/x)\nAGENTRUN_BASE_URL=http://127.0.0.1:7341/v2\nOp", "en http://127.0.0.1:7341/\n", "Open http://127.0.0.1:7341/other\nGET /v2/health 200\n"]);
  t.after(() => plain.kill());
  assert.equal(await openUrl(plain.stdout), "http://127.0.0.1:7341/");
  const link = stub(["agentrun-serve on http://127.0.0.1:7342/v2\r\n", "Open http://127.0.0.1:7342/pair?code=Q7-2x (signs this browser in, once)\r\n"]);
  t.after(() => link.kill());
  assert.equal(await openUrl(link.stdout), "http://127.0.0.1:7342/pair?code=Q7-2x", "a sign-in link is taken as it is, without the words after it");
  const elsewhere = stub(["Open https://agents.example.com/ (the public address)\n", "Open file:///etc/passwd\n", "Open not-a-url\n", "Open http://127.0.0.1:7343/\n"]);
  t.after(() => elsewhere.kill());
  assert.equal(await openUrl(elsewhere.stdout), "http://127.0.0.1:7343/", "only an http(s) URL on the loopback address this command started the server on");
});

test("an API-only server's line stands for the Open line: the address is its AGENTRUN_BASE_URL line's, on the loopback address or the public URL alone", async (t) => {
  const api = stub(["agentrun-serve on http://127.0.0.1:7345/v2 (agent store in /tmp/x)\nAGENTRUN_BASE_URL=http://127.0.0.1:7345/v2\nAGENTRUN_API_KEY=$AGENTRUN_TOKEN\n", "API only (AGENTRUN_API_ONLY=1): the run and deploy routes are served; the console, sign-in, setup, settings, MCP, triggers and hooks are refused.\n", "GET /v2/health 200\n"]);
  t.after(() => api.kill());
  assert.equal(await openUrl(api.stdout), "http://127.0.0.1:7345/v2");
  const published = stub(["AGENTRUN_BASE_URL=https://agents.example.com/v2\n", "API only (AGENTRUN_API_ONLY=1): the run routes are served.\n"]);
  t.after(() => published.kill());
  assert.equal(await openUrl(published.stdout, "https://agents.example.com"), "https://agents.example.com/v2", "at the public URL the server was started with");
  const elsewhere = stub(["AGENTRUN_BASE_URL=https://agents.example.com/v2\n", "API only (AGENTRUN_API_ONLY=1): the run routes are served.\n"], { exit: true });
  t.after(() => elsewhere.kill());
  assert.equal(await openUrl(elsewhere.stdout), undefined, "a base URL on another host is no address this command names");
  const early = stub(["API only (AGENTRUN_API_ONLY=1): the run routes are served.\n", "AGENTRUN_BASE_URL=http://127.0.0.1:7346/v2\n"], { exit: true });
  t.after(() => early.kill());
  assert.equal(await openUrl(early.stdout), undefined, "the API-only line stands for the Open line only after the base URL it names");
});

test("the lines after the Open line go on, one whole line at a time, however the output is cut; the bin says the boxes and setup lines among them", async (t) => {
  const server = stub(["agentrun-serve on http://127.0.0.1:7344/v2\nOpen http://127.0.0.1:7344/\nBox", "es: docker (on by default; set AGENTRUN_BOXES to change).\nGET /v2/health 200\n", "Set up this server: https://agentrun.example.com/setup#code=AbCd", "EfGh\n", "GET /v2/agents 200\n"]);
  t.after(() => server.kill());
  const after = [];
  assert.equal(await openUrl(server.stdout, undefined, [], (line) => after.push(line)), "http://127.0.0.1:7344/");
  for (let i = 0; after.length < 4; i++) {
    assert.ok(i < 100, JSON.stringify(after));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(after.filter((line) => start.SAID.test(line)), ["Boxes: docker (on by default; set AGENTRUN_BOXES to change).", "Set up this server: https://agentrun.example.com/setup#code=AbCdEfGh"]);
  assert.equal(start.SAID.test("GET /v2/health 200"), false);
  assert.equal(start.SAID.test("From another machine: http://192.0.2.10:7401/setup#code=AbCdEfGh"), true, "the setup link at this machine's other addresses is said too");
});

// --public-url: the address people open, through a proxy in front of the server on loopback. The example names are a
// reserved one and a made-up tailnet's, never a real machine's.
const TAILNET_URL = "https://box.tailnet.example/";
/** An address with a password and a port that is no number, so it does not parse: built from its parts, so no address
 *  with a password in it is written in the source. */
const MALFORMED_WITH_PASSWORD = `https://${["someone", "hunter2"].join(":")}${"@"}box.tailnet.example:invalid/`;

test("--public-url URL is the server's public address: the server gets it as AGENTRUN_PUBLIC_URL, never as a flag, and the line names it", { timeout: 60_000 }, async (t) => {
  const run = await throughStub(t, ["--no-open", "--public-url", TAILNET_URL], { STUB_OPEN: TAILNET_URL });
  assert.equal(run.code, 0, run.err);
  assert.equal(run.public, TAILNET_URL, "the server's public address");
  assert.deepEqual(run.args, ["--data", STORE(run.home)], "the server has no such flag: it is not passed on");
  assert.equal(run.out, `AgentRun is running at ${TAILNET_URL}\n`, run.err);
  // The equals form is the same option, and AGENTRUN_PUBLIC_URL naming the same address (no slash) agrees with it.
  const equals = await throughStub(t, ["--no-open", `--public-url=${TAILNET_URL}`], { STUB_OPEN: TAILNET_URL, AGENTRUN_PUBLIC_URL: TAILNET_URL.replace(/\/$/, "") });
  assert.deepEqual([equals.code, equals.public, equals.out], [0, TAILNET_URL, `AgentRun is running at ${TAILNET_URL}\n`], equals.err);
  // The variable alone still works, as it did.
  const env = await throughStub(t, ["--no-open"], { STUB_OPEN: TAILNET_URL, AGENTRUN_PUBLIC_URL: TAILNET_URL });
  assert.deepEqual([env.code, env.public], [0, TAILNET_URL], env.err);
  // Plain http is taken for this machine's own names.
  const local = await throughStub(t, ["--no-open", "--public-url", "http://127.0.0.1:8080/"], { STUB_OPEN: "http://127.0.0.1:8080/" });
  assert.deepEqual([local.code, local.public], [0, "http://127.0.0.1:8080/"], local.err);
});

test("--public-url on loopback trusts the proxy in front (AGENTRUN_TRUSTED_PROXIES=loopback), as --tailscale does, so each visitor's sign-ins count by their own address; an operator's value stays, and a non-loopback --listen trusts none", { timeout: 60_000 }, async (t) => {
  // The service's command line (service install --public-url): every start of it gets the same.
  const loop = await throughStub(t, ["--no-open", "--port", "7345", "--public-url", TAILNET_URL], { STUB_OPEN: TAILNET_URL });
  assert.deepEqual([loop.code, loop.public, loop.proxies], [0, TAILNET_URL, "loopback"], loop.err);
  const named = await throughStub(t, ["--no-open", "--listen", "127.0.0.1", "--public-url", TAILNET_URL], { STUB_OPEN: TAILNET_URL });
  assert.equal(named.proxies, "loopback", named.err);
  const operator = await throughStub(t, ["--no-open", "--public-url", TAILNET_URL], { STUB_OPEN: TAILNET_URL, AGENTRUN_TRUSTED_PROXIES: "10.0.0.0/8" });
  assert.deepEqual([operator.code, operator.proxies], [0, "10.0.0.0/8"], operator.err);
  // Set to nothing, it trusts no proxy: an operator's choice too, never replaced with loopback.
  const none = await throughStub(t, ["--no-open", "--public-url", TAILNET_URL], { STUB_OPEN: TAILNET_URL, AGENTRUN_TRUSTED_PROXIES: "" });
  assert.deepEqual([none.code, none.proxies], [0, ""], none.err);
  const wide = await throughStub(t, ["--no-open", "--listen", "0.0.0.0", "--public-url", TAILNET_URL], { STUB_OPEN: TAILNET_URL });
  assert.deepEqual([wide.code, wide.public, wide.proxies], [0, TAILNET_URL, null], wide.err);
  // No --public-url: nothing trusted, as before.
  const plain = await throughStub(t, ["--no-open"]);
  assert.equal(plain.proxies, null, plain.err);
});

test("--public-url is refused, exit 2 before the server starts, when it is no https root address or AGENTRUN_PUBLIC_URL names another", { timeout: 60_000 }, async (t) => {
  const refused = {
    "http://box.tailnet.example/": /--public-url takes an https address: over http:\/\/ the password and the session cross the network in clear text/,
    "https://box.tailnet.example/agentrun": /--public-url takes the address of the server's root, https:\/\/box\.tailnet\.example\/, with no path/,
    "https://box.tailnet.example/?a=1": /with no path, query or fragment/,
    // Built, so no address with a password in it is written in the source.
    [Object.assign(new URL(TAILNET_URL), { username: "someone", password: "hunter2" }).href]: /--public-url takes an address with no user name or password in it/,
    "ftp://box.tailnet.example/": /--public-url takes an https address/,
    "box.tailnet.example": /--public-url takes the https address people open AgentRun at, such as https:\/\/box\.tailnet\.example\/, not box\.tailnet\.example\./,
    // No address, so not yet checked for a password: it is not repeated.
    [MALFORMED_WITH_PASSWORD]: /^--public-url takes the https address people open AgentRun at, such as https:\/\/box\.tailnet\.example\/\.$/m,
  };
  for (const [given, why] of Object.entries(refused)) {
    const run = await throughStub(t, ["--no-open", "--public-url", given]);
    assert.equal(run.code, 2, `${given}: ${run.err}`);
    assert.match(run.err, why, given);
    assert.equal(run.args, undefined, `${given}: the server was not started`);
    assert.equal(run.out, "");
    assert.equal(run.err.includes("hunter2"), false, "a password in the address is never repeated");
  }
  const missing = await throughStub(t, ["--no-open", "--public-url"]);
  assert.deepEqual([missing.code, missing.args], [2, undefined], missing.err);
  assert.match(missing.err, /^--public-url takes the https address people open AgentRun at/m);
  const both = await throughStub(t, ["--no-open", "--public-url", TAILNET_URL], { AGENTRUN_PUBLIC_URL: "https://agentrun.example.com" });
  assert.deepEqual([both.code, both.args], [2, undefined], both.err);
  assert.match(both.err, /^AGENTRUN_PUBLIC_URL names another address than --public-url https:\/\/box\.tailnet\.example\/, and the server takes one\. Give one of them\.$/m);
});

test("publicUrlOf and chosenPublicUrl: the root of an https address, http on loopback; the flag and the variable agree or are refused", () => {
  assert.deepEqual(publicUrlOf("https://Box.Tailnet.Example"), { url: TAILNET_URL });
  assert.deepEqual(publicUrlOf("https://agentrun.example.com:8443/"), { url: "https://agentrun.example.com:8443/" });
  for (const local of ["http://localhost:7340/", "http://127.0.0.1:7340", "http://[::1]:7340/"]) assert.equal(publicUrlOf(local).error, undefined, local);
  assert.equal(publicUrlOf(MALFORMED_WITH_PASSWORD).error.includes("hunter2"), false, "a malformed address is not repeated when it may hold a password");
  for (const bad of ["http://10.0.0.5:7340/", "http://agentrun.example.com/", "https://agentrun.example.com/#x", "https://user@agentrun.example.com/", "", "not a url"]) assert.ok(publicUrlOf(bad).error, bad);
  assert.deepEqual(chosenPublicUrl(undefined, undefined), { url: undefined });
  assert.deepEqual(chosenPublicUrl(undefined, "https://agentrun.example.com"), { url: "https://agentrun.example.com" }, "the variable alone is the server's to check");
  assert.deepEqual(chosenPublicUrl(TAILNET_URL, "https://box.tailnet.example"), { url: TAILNET_URL });
  assert.match(chosenPublicUrl(TAILNET_URL, "https://agentrun.example.com").error, /names another address/);
});

/** A folder for PATH holding the fake tailscale (fake-tailscale.sh) in `mode`, or nothing (`none`), and its state: what
 *  it was asked is in `calls()`. PATH is that folder alone, so this machine's own tailscale is never found. */
function fakeTailscale(mode) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-ts-hint-"));
  removeAtEnd(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "state"));
  if (mode !== "none") {
    cpSync(new URL("fake-tailscale.sh", import.meta.url).pathname, join(dir, "bin", "tailscale"));
    writeFileSync(join(dir, "state", "mode"), `${mode}\n`);
  }
  const calls = () => (existsSync(join(dir, "state", "calls")) ? readFileSync(join(dir, "state", "calls"), "utf8").split("\n").filter(Boolean) : []);
  // CI empty: the hint is for a person, and is never looked for in CI.
  return { env: { PATH: join(dir, "bin"), FAKE_TAILSCALE_DIR: join(dir, "state"), CI: "" }, calls };
}

const HINT = [
  "Tailscale is running here: AgentRun could be at https://box.tail1234.example/ for your devices on your tailnet, and no one else. To serve it there:",
  "  1. tailscale serve --bg 7399",
  "  2. Stop AgentRun and start it again with --port 7399 --public-url https://box.tail1234.example/ added to its command",
].join("\n");

test("on loopback with no public address and Tailscale signed in here, the start says once (stderr) the tailnet address and the two commands to it, having only read Tailscale's status", { timeout: 60_000 }, async (t) => {
  const ts = fakeTailscale("ok");
  const run = await throughStub(t, ["--no-open"], ts.env);
  assert.equal(run.code, 0, run.err);
  assert.equal(run.out, "AgentRun is running at http://127.0.0.1:7399/\n", "stdout stays the one line");
  assert.ok(run.err.includes(`\n${HINT}\n`), run.err);
  assert.equal(run.err.split("Tailscale is running here").length, 2, "said once");
  assert.doesNotMatch(run.err, /funnel/i, "never Funnel");
  assert.deepEqual(ts.calls(), ["status --json"], "Tailscale is only read, never changed");
  assert.equal(tailnetHint("box.tail1234.example", "7399"), HINT);
});

test("no Tailscale hint where Tailscale is missing, signed out or not running, with a public address, on another listen address, or in CI", { timeout: 60_000 }, async (t) => {
  for (const mode of ["none", "logged-out", "down"]) {
    const ts = fakeTailscale(mode);
    const run = await throughStub(t, ["--no-open"], ts.env);
    assert.equal(run.code, 0, `${mode}: ${run.err}`);
    assert.doesNotMatch(run.err, /Tailscale|tailscale/, `${mode}: nothing said`);
  }
  const cases = [
    ["--public-url", [["--no-open", "--public-url", TAILNET_URL], { STUB_OPEN: TAILNET_URL }]],
    ["AGENTRUN_PUBLIC_URL", [["--no-open"], { STUB_OPEN: TAILNET_URL, AGENTRUN_PUBLIC_URL: TAILNET_URL }]],
    ["--listen 0.0.0.0", [["--no-open", "--listen", "0.0.0.0"], {}]],
    ["CI", [["--no-open"], { CI: "true" }]],
  ];
  for (const [name, [args, env]] of cases) {
    const ts = fakeTailscale("ok");
    const run = await throughStub(t, args, { ...ts.env, ...env });
    assert.equal(run.code, 0, `${name}: ${run.err}`);
    assert.doesNotMatch(run.err, /Tailscale is running here/, name);
    assert.deepEqual(ts.calls(), [], `${name}: Tailscale is not even read`);
  }
});

test("tailnetNameOf reads the name of a signed-in tailnet, and gives up silently on a status that does not answer in time", { timeout: 30_000 }, async () => {
  assert.equal(await tailnetNameOf({ env: fakeTailscale("ok").env }), "box.tail1234.example");
  assert.equal(await tailnetNameOf({ env: fakeTailscale("logged-out").env }), undefined);
  assert.equal(await tailnetNameOf({ env: fakeTailscale("none").env }), undefined);
  const dir = mkdtempSync(join(tmpdir(), "agentrun-ts-slow-"));
  removeAtEnd(dir);
  writeFileSync(join(dir, "tailscale"), `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`, { mode: 0o755 });
  const began = Date.now();
  assert.equal(await tailnetNameOf({ env: { PATH: dir }, timeoutMs: 300 }), undefined);
  assert.ok(Date.now() - began < 5_000, "bounded by its timeout");
  assert.deepEqual(["--listen 127.0.0.1", "--listen=::1", "--listen localhost", ""].map((args) => onLoopback(args.split(" ").filter(Boolean))), [true, true, true, true]);
  assert.deepEqual([["--listen", "0.0.0.0"], ["--listen=192.168.1.4"], ["--listen", "127.0.0.1", "--listen", "::"]].map(onLoopback), [false, false, false]);
});

test("with a public URL and no password yet, the server's setup-code line reaches the person (stderr), not stdout", { timeout: 60_000 }, async (t) => {
  const setup = "https://agentrun.example.com/setup#code=AbCdEfGhIjKlMnOpQrStUv";
  const run = await throughStub(t, ["--no-open"], { AGENTRUN_PUBLIC_URL: "https://agentrun.example.com", STUB_OPEN: "https://agentrun.example.com/", STUB_SETUP: setup });
  assert.equal(run.out, "AgentRun is running at https://agentrun.example.com/\n", "stdout stays the one line");
  assert.match(run.err, new RegExp(`^Set up this server: ${setup.replace(/[.?#/]/g, "\\$&")}$`, "m"), run.err);
  assert.ok(start.SAID.test(`Set up this server: ${setup}`));
});

test("an Open line's URL is its first word, an http(s) URL on the server's loopback address; nothing else is", () => {
  assert.equal(openLineUrl("Open http://127.0.0.1:7340/"), "http://127.0.0.1:7340/");
  // With AGENTRUN_PUBLIC_URL the server's "Open " line names that address: it's taken when it is that origin, and only then.
  assert.equal(openLineUrl("Open https://agentrun.example.com/", "https://agentrun.example.com"), "https://agentrun.example.com/");
  assert.equal(openLineUrl("Open https://agentrun.example.com/pair?code=x", "https://agentrun.example.com/"), "https://agentrun.example.com/pair?code=x");
  assert.equal(openLineUrl("Open https://agentrun.example.com/"), undefined, "no public URL given");
  assert.equal(openLineUrl("Open https://elsewhere.example.com/", "https://agentrun.example.com"), undefined, "another origin");
  assert.equal(openLineUrl("Open http://127.0.0.1:7340/pair?code=a.b-c (signs this browser in, once)"), "http://127.0.0.1:7340/pair?code=a.b-c");
  for (const line of ["Open https://agents.example.com/", "Open ftp://127.0.0.1/", "Open javascript:alert(1)", "Open ", "Opening http://127.0.0.1:7340/", "open http://127.0.0.1:7340/", " Open http://127.0.0.1:7340/"]) {
    assert.equal(openLineUrl(line), undefined, line);
  }
});

test("a server whose output ends with no \"Open \" line gives no address", async () => {
  const silent = stub(["agentrun-serve: --port takes a port number\n", "Opening is not the line\n"], { exit: true });
  assert.equal(await openUrl(silent.stdout), undefined);
});

// The repository's Node rule, at the top of the bin and not behind a main-module guard (Node 20 has none, and a guarded
// check there would pass by doing nothing): an older Node gets one line saying what to install, and exit 1.
test("on a Node below the package's engines floor the bin says, in one line, the floor it needs and the installer's command, and exits 1 before it loads anything", () => {
  // The floor the line names is the package's engines.node, never a number of its own (it once said 22.19 and 24.2).
  const engines = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
  const [, needMajor, needMinor, needPatch] = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engines).map(Number);
  assert.deepEqual([needMajor, needMinor, needPatch], [24, 22, 3], "the floor this test was written at: Node's November 2026 security release");
  const floor = `${needMajor}.${needMinor}.${needPatch}`;
  const fakeNode = (node) => `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process, "versions", { value: { ...process.versions, node: "${node}" } });`)}`;
  // The patch counts: a Node on the floor's minor below its patch lacks the security fixes, and is refused too.
  for (const node of ["20.20.0", "22.23.5", "23.11.0", "24.2.0", "24.11.0", "24.21.0", `${needMajor}.${needMinor - 1}.9`, `${needMajor}.${needMinor}.0`, `${needMajor}.${needMinor}.${needPatch - 1}`]) {
    const run = spawnSync(process.execPath, ["--import", fakeNode(node), BIN, "--help"], { encoding: "utf8" });
    assert.deepEqual([run.status, run.stdout, run.stderr], [1, "", `AgentRun needs Node.js ${floor} or newer; you have v${node}. To install AgentRun with a Node.js of its own, run: curl -fsSL https://agentrun.ai/install | sh\n`], node);
  }
  // At the floor itself, and past it on a later patch, the check passes: the bin goes on and prints its usage.
  for (const node of [floor, `${needMajor}.${needMinor}.${needPatch + 7}`, `${needMajor}.${needMinor + 1}.0`]) {
    const at = spawnSync(process.execPath, ["--import", fakeNode(node), BIN, "--help"], { encoding: "utf8" });
    assert.doesNotMatch(at.stderr, /AgentRun needs Node\.js/, `${node}: ${at.stderr}`);
    assert.equal(at.status, 0, `${node}: ${at.stderr}`);
  }
});

// Exercise the actual onboarding recipes, without npm installs, real servers or model credentials.
function setupRecipe() {
  const skill = readFileSync(new URL("../../serve/skills/agentrun-serve/SKILL.md", import.meta.url), "utf8");
  const step = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]).find((block) => block.includes("node packages/serve/dist/cli.js"));
  assert.ok(step, "the skill has its server-start recipe");
  return step;
}
const setupSkill = () => readFileSync(new URL("../../../docs/SKILL.md", import.meta.url), "utf8");
const skillSection = (skill, title) => skill.split(/^## /m).find((part) => part.startsWith(`${title}\n`)) ?? "";
const shellBlocks = (text) => [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
// The website serves this file with the release's install.sh, so the prompt starts AgentRun with that installer, which
// brings its own Node, and every later command is the one it installs: no Node check, no nvm, no npx.
test("the setup skill installs with the installer and runs the command it installs", (t) => {
  const skill = setupSkill();
  const here = skillSection(skill, "3. Start it where they chose").split(/^### /m).find((part) => part.startsWith("This computer\n"));
  const [look, install, ...more] = shellBlocks(here);
  assert.equal(install, "curl -fsSL https://agentrun.ai/install | sh\n", "this computer's one command is the installer");
  assert.deepEqual(more, []);
  // A server started before the installer existed (npx) has no ~/.agentrun/bin/agentrun: its record finds it.
  assert.match(look, /~\/\.agentrun\/\.server\.json/);
  assert.doesNotMatch(look, /agentrun\/bin|\| sh/, "the reuse check needs no installed command and installs nothing");
  const f = setupFixture(t, { curl: 'echo "curl $*"' });
  assert.equal(f.run(look, { HOME: f.dir }).status, 1, "no record: nothing to reuse");
  mkdirSync(join(f.dir, ".agentrun"));
  const record = join(f.dir, ".agentrun", ".server.json");
  writeFileSync(record, `${JSON.stringify({ base_url: "http://127.0.0.1:7341/v2", pid: 42 }, null, 2)}\n`);
  const home = { HOME: f.dir };
  assert.equal(f.run(look, home).stdout, "curl -fsS --max-time 3 http://127.0.0.1:7341/v2/health\n");
  assert.match(here, /When `~\/\.agentrun\/bin\/agentrun` is missing, install the command alone, which\s+leaves that server running: `curl -fsSL https:\/\/agentrun\.ai\/install \| sh -s -- --no-start`/);
  assert.match(here, /`~\/\.agentrun\/bin\/agentrun service restart`/);
  assert.match(here, /`~\/\.agentrun\/bin\/agentrun stop` stops it and the installer line starts it again/);
  assert.match(here, /in this session always write the full path/, "the PATH line the installer adds reaches only a new terminal");
  assert.doesNotMatch(skill, /\bnpx\b|\bnvm\b|node --version|Node(\.js)? \d/, "no Node check and no npx");
  assert.doesNotMatch(skill, /<!-- (INSTALLER|RAILWAY|WORKAROUND)\b/, "no marker left");
  const commands = [...skill.matchAll(/(?:^|[\s`(])((?:~\/\.agentrun\/bin\/)?agentrun) (agents|runs|server|native|import|service|login|stop)\b/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 10, `${commands.length} commands`);
  assert.deepEqual([...new Set(commands)], ["~/.agentrun/bin/agentrun"], "every command is the installed one, by its full path");
});
// Found in QA: on an SSH box, the setup agent tried to add a route to the machine's shared Traefik config, with sudo
// as its fallback. The skill names the one way to the console from a remote machine, the person's own port forward, and
// rules out every change to the machine.
test("the setup skill opens a remote machine's console through the person's port forward, never through the machine's proxy or sudo", () => {
  const open = skillSection(setupSkill(), "3. Start it where they chose").split(/^### /m).find((part) => part.startsWith("Open the setup page\n")) ?? "";
  assert.match(open, /`ssh -o ExitOnForwardFailure=yes -L\s+<local>:127\.0\.0\.1:<port> <user>@<host>`/);
  assert.match(open, /`http:\/\/127\.0\.0\.1:<local>\/` in place of its\s+address, keeping any `#code=\.\.\.`/);
  assert.match(open, /An always-on machine's tailnet or HTTPS address needs no forward/);
  assert.match(open, /no change to the machine's web server or reverse proxy \(Traefik, nginx,\s+Caddy/);
  assert.match(open, /no new route, DNS name or firewall rule, and no `sudo`/);
});

test("the setup skill's Railway step is the published template's button, with the token from its Variables tab", () => {
  const skill = setupSkill();
  const hosted = skillSection(skill, "3. Start it where they chose");
  assert.match(hosted, /\*\*Railway:\*\* they open https:\/\/railway\.com\/deploy\/agentrun/);
  assert.match(hosted, /never create the service yourself with a Railway CLI/i);
  assert.doesNotMatch(skill, /ghcr\.io|RAILWAY_PUBLIC_DOMAIN|PORT=7340/, "no hand-made service");
  assert.match(hosted, /On Railway, the service's \*\*Variables\*\* tab holds `AGENTRUN_TOKEN`/);
});
// Every choice the setup prompt offers, as the question tool's call: its header, its question and its options' labels.
// A choice written as chat text is the failure these tests exist for: models answer a prose list in prose, skip the
// recommendation, or go on before the person picks.
const QUESTION = /[Qq]uestion tool, header `([^`]+)`: "([^"]*)"/g;
function setupQuestions(skill) {
  return [...skill.matchAll(QUESTION)].map((m) => {
    const rest = skill.slice(m.index + m[0].length);
    const paragraph = rest.split(/\n\s*\n/)[0];
    const options = [...paragraph.matchAll(/^\s*- ([^:\n]+?)(?: \(Recommended\))?: /gm)].map((o) => o[1]);
    const recommended = [...paragraph.matchAll(/^\s*- ([^:\n]+?) \(Recommended\): /gm)].map((o) => o[1]);
    return { header: m[1], question: m[2], at: m.index, paragraph, options, recommended };
  });
}
// The sentences outside "How to ask" that ask the person something without the question tool: a quoted question, a
// "tell me which" or "reply with", or an ask that is neither a question-tool call nor a marked free-text question.
function proseChoices(skill) {
  const body = skill.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^## How to ask\n[\s\S]*?(?=^## )/m, "").replace(/```[\s\S]*?```/g, "").replace(/^#.*$/gm, "")
    .replace(QUESTION, "QUESTION").replace(/\s+/g, " ");
  return body.split(/(?<=[.!?])\s+(?=[A-Z*`"(<0-9])/).map((sentence) => sentence.trim()).filter((sentence) =>
    ((/"[^"]*\?"/.test(sentence) || /\?"?$/.test(sentence)) && !sentence.includes("QUESTION")) ||
    /\b(tell me which|reply with|let me know|would you like|do you want)\b/i.test(sentence) ||
    (/\bask(s|ed|ing)?\b/i.test(sentence) && !/QUESTION|question tool|\(free text|^Before asking anything|^Never ask|asks for a (\*\*)?setup code/i.test(sentence)));
}
test("the setup skill's choice check flags a choice written as prose and passes a question-tool question", () => {
  assert.deepEqual(proseChoices("## 1. A\n\nAsk whether they want Railway or Render. Which one? \"Railway or Render?\" Tell me which.\n"), [
    "Ask whether they want Railway or Render.", "Which one?", "\"Railway or Render?\" Tell me which.",
  ]);
  assert.deepEqual(proseChoices("## How to ask\n\nAsk with the tool.\n\n## 1. A\n\nQuestion tool, header `Host`: \"Which host?\"\n- A (Recommended): b\n- C: d\n\nAsk for the task (free text, one plain message).\n"), []);
});
test("the setup skill asks every choice with the host's question tool, recommended option first", () => {
  const skill = setupSkill();
  assert.ok(skill.split(/^## /m)[1].startsWith("How to ask\n"), "How to ask is the first section, before anything that could read as 'just tell them'");
  const how = skillSection(skill, "How to ask");
  for (const tool of ["`AskUserQuestion`", "`request_user_input`", "`AskQuestion`", "`question`"]) assert.ok(how.includes(tool), tool);
  assert.match(how, /Call the tool; don't write the choices as chat text\./);
  assert.match(how, /Reply with a number\." Then stop\./, "a host with no tool gets a numbered fallback that stops the turn");
  assert.match(how, /Never answer a question for the person, and never pass a flag that answers one\./);
  assert.doesNotMatch(skill, /\bbatch/i, "nothing tells the model to batch its questions into one message");
  const questions = setupQuestions(skill);
  assert.deepEqual(questions.map((q) => q.header), ["Run where", "Scan", "Host", "Local reach", "Agent", "First run", "Model", "First run"], "every choice point, in order");
  for (const q of questions) {
    assert.ok(q.header.length <= 12, `${q.header}: a header of 12 characters or less`);
    assert.match(q.question, /\?/, `${q.header} asks a question`);
    assert.match(q.paragraph, /Recommendation: [^.]+?\sbecause\s/, `${q.header} says what it recommends and why`);
    if (q.header === "Agent") continue;
    assert.ok(q.options.length >= 2 && q.options.length <= 3, `${q.header}: 2 or 3 options, as every host takes: ${q.options}`);
    assert.deepEqual(q.recommended, [q.options[0]], `${q.header}: the first option is the one recommended`);
    for (const label of q.options) assert.ok(label.split(/\s+/).length <= 5, `${q.header}: "${label}" is 1-5 words`);
  }
  const options = Object.fromEntries(questions.map((q) => [q.header, q.options]));
  assert.deepEqual(options["Run where"], ["This computer", "My always-on machine", "A hosted service"]);
  assert.deepEqual(options.Scan, ["Check", "I'll tell you", "No, start fresh"]);
  assert.deepEqual(options.Host, ["Railway", "Render", "AgentRun Cloud"]);
  assert.deepEqual(options["Local reach"], ["Not now", "Yes, only me"], "the start-time switches stay off unless the person says only they use the machine");
  assert.deepEqual(options.Model, ["Continue with ChatGPT", "OpenRouter key", "Local model"], "ChatGPT, then a capped key, then a local model");
  assert.match(questions.find((q) => q.header === "Agent").paragraph, /then \*\*Start\s+fresh\*\*/, "a found agent or a fresh start");
  assert.deepEqual(proseChoices(skill), [], "no choice is written as prose");
});
// A person pasted the setup prompt into a hosted cloud session: it installed there, the console sat on a loopback their
// browser could not reach, and a signed-in provider was taken as a choice. The prompt now reads the session first and
// asks where before any install or deploy, with each place's cost. In the same call it asks to look, read-only, for the
// Claude Code and Codex jobs the person already schedules: a found one is the first run, ahead of any model step.
test("the setup skill asks where AgentRun should run before any install, with a cost for each place, and looks for existing agents first", () => {
  const skill = setupSkill();
  const title = "2. Ask where it runs, and whether to look for their agents";
  const where = skillSection(skill, title);
  assert.match(where, /^Before any install or deploy command, ask these two with the question tool in one call/m);
  const costs = Object.fromEntries(setupQuestions(where).flatMap((q) => [...q.paragraph.matchAll(/^- ([^:(]+?)(?: \(Recommended\))?: (.+)$/gm)]).map((m) => [m[1], m[2]]));
  assert.match(costs["This computer"], /^free;/);
  assert.match(costs["My always-on machine"], /^free;/);
  assert.match(costs.Railway, /^about \$5 a month/);
  assert.match(costs.Render, /^about \$27\.50 a month/);
  assert.match(costs["AgentRun Cloud"], /^hosted for you; request access/);
  assert.doesNotMatch(skill, /AgentRun Cloud[^\n]*\$\d/, "AgentRun Cloud names no price");
  assert.match(where, /A provider CLI that is signed in, a deploy button, `render\.yaml` or a README section\s+is never a choice/);
  assert.match(where, /Never create a service on a provider the person did not name in this conversation/);
  const installs = /npx |curl -fsSL|tailscale serve|docker (run|compose)|render\.com\/deploy|agents create|runs start/;
  const before = skill.slice(0, skill.indexOf(`## ${title}`));
  assert.ok(skill.indexOf(`## ${title}`) > 0);
  for (const block of shellBlocks(before)) assert.doesNotMatch(block, installs, "nothing before the question installs or deploys");
  assert.doesNotMatch(before, installs, "nothing before the question names an install");
  assert.doesNotMatch(skill, /on this machine\b/i, "no place is assumed");
  const at = (heading) => { const i = skill.indexOf(`## ${heading}`); assert.ok(i > 0, heading); return i; };
  assert.ok(at("4. Look for the agents they already run") < at("5. Bring in the agent they picked"));
  assert.ok(at("5. Bring in the agent they picked") < at("6. Connect a model"), "a found agent comes before any model step");
  assert.match(skillSection(skill, "3. Start it where they chose"), /On \*\*Check\*\*, run the step 4 scan now, while AgentRun installs/);
  const found = skillSection(skill, "4. Look for the agents they already run");
  for (const look of ["crontab -l", "list-timers", "LaunchAgents", ".github/workflows", "claude -p", "codex exec"]) assert.ok(found.includes(look), look);
  assert.match(found, /ask the person which of their jobs start\s+agents/, "a job the filter cannot see is asked about, not assumed absent");
  assert.match(found, /Show at most three finds, one line each: tool, schedule, where\./);
  const bring = skillSection(skill, "5. Bring in the agent they picked");
  assert.match(bring, /native connect --project <folder> --runtime claude-code/);
  assert.match(bring, /import --from claude-code\s+--dry-run/);
  assert.match(bring, /need no model key/);
  assert.match(bring, /It is a real run of that job: it may\s+post or write wherever the job does\./, "the first run of a found job is named as a real run");
});
// The server runs an agent whose tools need no shell (`tools: []`) on the runner, and never asks an unlisted gateway model
// to stop reasoning, so the first agent's definition names neither a place nor a thinking level. With no tools named it
// would get bash and the Docker box, and wait for a container. A local model reaches a service through
// `service install --env`; only Ollama has been walked.
test("the setup skill's model step offers ChatGPT, a capped key, then a local Ollama model on the service, and its first agent is the template's alone", () => {
  const skill = setupSkill();
  const model = skillSection(skill, "6. Connect a model");
  assert.match(model, /Never start a model download\./);
  assert.match(model, /offer it only when a model with tool calling is already pulled/);
  const [install] = shellBlocks(model);
  assert.equal(install, "~/.agentrun/bin/agentrun service install --env AGENT_MODEL_BASE_URL=http://localhost:11434/v1 --env AGENT_MODEL_GATEWAY_IDS=bare --env AGENT_MODEL=<tag> --env AGENT_MODEL_PRICE=0,0,0 --env AGENT_MODEL_API_KEY=none\n");
  // A server that holds no key for its gateway refuses a run that brings none (model_key_required): Ollama takes no key,
  // so the service sends `none`, in the service and in front of `sh` alike.
  assert.match(model, /\| AGENT_MODEL_API_KEY=none AGENT_MODEL_BASE_URL=http:\/\/localhost:11434\/v1\s+AGENT_MODEL_GATEWAY_IDS=bare AGENT_MODEL=<tag> AGENT_MODEL_PRICE=0,0,0 sh/);
  assert.doesNotMatch(skill, /LM Studio|localhost:1234/);
  // Yes, only me (step 3) survives the model's restart: the service keeps what service install --env saved, and a
  // background start keeps only what its line sets, so the line carries both switches.
  const start = skillSection(skill, "3. Start it where they chose");
  assert.match(start, /service install --env AGENTRUN_MCP_ALLOW_LOOPBACK=1 --env\s+AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1/);
  assert.match(model, /on \*\*Yes, only me\*\* \(step 3\) put `AGENTRUN_MCP_ALLOW_LOOPBACK=1 AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` in\s+front of `sh` too/);
  assert.match(model, /https:\/\/openrouter\.ai\/keys, create a key, set its credit limit/);
  assert.match(model, /Claude\s+Max, Ultra\s+and Team plans include monthly API credits/);
  assert.doesNotMatch(skill, /(Sign in|Continue) with Claude/i);
  const first = skillSection(skill, "7. Create the first agent and run it");
  const create = shellBlocks(first).find((block) => block.includes("agents create"));
  const definition = JSON.parse(create.match(/--body '(.+)'/)[1]).definition;
  assert.deepEqual(Object.keys(definition).sort(), ["harness", "id", "instructions", "max_cost_usd", "name", "tools"], "no place or thinking");
  assert.deepEqual(definition.tools, [], "no tools: an agent that needs no shell runs on the runner");
  assert.equal(definition.max_cost_usd, 0.25);
});
test("the setup skill names a hosted cloud session before the questions, and its check prints names, never values", (t) => {
  const skill = setupSkill();
  const look = skillSection(skill, "1. Look at this session");
  assert.match(look, /`CLAUDE_CODE_REMOTE`[^\n]*\n?[^\n]*a \*\*hosted cloud session\*\*/, "the cloud signal is read as a hosted session");
  assert.match(look, /In a hosted cloud session or sandbox, say so first, in one or two sentences, before the questions below/);
  assert.match(skillSection(skill, "2. Ask where it runs, and whether to look for their agents"),
    /In a hosted cloud session or sandbox, the options are \*\*A hosted service \(Recommended\)\*\*/, "there, the hosted option comes first");
  const [check] = shellBlocks(look);
  assert.ok(check, "the session check is a shell block");
  const f = setupFixture(t, {});
  const quiet = Object.fromEntries(["CLAUDE_CODE_REMOTE", "CODESPACES", "GITPOD_WORKSPACE_ID", "SSH_CONNECTION", "DISPLAY", "WAYLAND_DISPLAY"].map((name) => [name, ""]));
  const run = f.run(check, { ...quiet, CLAUDE_CODE_REMOTE: "private-fixture-true", SSH_CONNECTION: "private-fixture 22" });
  assert.equal(run.status, 0, `a check that finds nothing more still succeeds: ${run.stderr}`);
  const lines = run.stdout.split("\n").filter((line) => line.startsWith("set: "));
  assert.deepEqual(lines, ["set: CLAUDE_CODE_REMOTE", "set: SSH_CONNECTION"], "each signal set, by name");
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /private-fixture/, "no value is printed");
});
// A person whose assistant set the server up was handed a link to click, then a command that prints the code, when the
// page could have been open already with the code in it. The skill has the assistant open the setup link itself.
test("the setup skill opens the setup page, code filled in, in the person's browser, and hands over a link only when it can open none", () => {
  const start = skillSection(setupSkill(), "3. Start it where they chose");
  const at = start.indexOf("### Open the setup page");
  assert.ok(at > start.indexOf("curl -fsSL https://agentrun.ai/install | sh\n"), "the step follows the start");
  assert.match(start.slice(0, at).replace(/\s+/g, " "), /it ends by opening the setup page there, where they set the owner password; otherwise open it for them \(below\)/);
  const step = start.slice(at).replace(/\s+/g, " ");
  assert.match(step, /never send a link for them to click while you can open it, and never a command that prints or fetches the code/);
  assert.match(step, /run `~\/\.agentrun\/bin\/agentrun open` on that machine/, "an installed server's link comes from agentrun open");
  for (const opener of ['open "<link>"', 'xdg-open "<link>"', 'start "" "<link>"', "your client's browser or preview tool"]) assert.ok(step.includes(opener), opener);
  assert.match(step, /Only when you have neither, send the link itself/);
  assert.match(step, /Set up this server: <address>\/setup#code=<code>/, "the link is the one the log prints, code and all");
  assert.match(step, /Never the API token/);
});
function setupFixture(t, commands) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-skill-"));
  mkdirSync(join(dir, "fake"));
  for (const [name, body] of Object.entries(commands)) writeFileSync(join(dir, "fake", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // A fake writes child.pid with `echo $$ >`, so the file can exist and still be empty, and Number("") is 0: a kill of pid 0
  // is a SIGKILL to this test's whole process group (node --test, npm, a CI shard's suite), which ends with nothing printed.
  // Only a whole pid past 1 is signalled.
  t.after(() => {
    const text = existsSync(join(dir, "child.pid")) ? readFileSync(join(dir, "child.pid"), "utf8").trim() : "";
    if (/^\d+$/.test(text) && Number(text) > 1) {
      try { process.kill(Number(text), "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, run: (step, env = {}) => spawnSync("sh", ["-c", step], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ...env, PATH: `${join(dir, "fake")}:${process.env.PATH}` } }) };
}
// A scheduled job carries its prompt, and often a key, on its command line, so a bare `crontab -l` hands both to the
// assistant. A timer or launchd listing shows no command at all, so a job could not be told from any other. The skill's
// discovery step reads each job's command on the machine and returns the schedule and the runtime's name, nothing else.
test("the setup skill's discovery step names scheduled Claude Code and Codex jobs without returning their prompts, keys or environment", (t) => {
  const skill = readFileSync(new URL("../../../docs/SKILL.md", import.meta.url), "utf8");
  const step = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]).find((block) => block.includes("crontab -l"));
  assert.ok(step, "the skill has its discovery step");
  const exec = (program, words) => `echo '{ path=${program} ; argv[]=${program} ${words} ; ignore_errors=no ; }'`;
  const f = setupFixture(t, {
    crontab: [
      "ANTHROPIC_API_KEY=private-fixture-key",
      "PATH=/opt/private-fixture/claude/bin:/usr/bin",
      "# 0 1 * * * claude -p 'a private-fixture-comment'",
      "30 2 * * 1-5 cd /srv/app && OPENAI_API_KEY=private-fixture-inline claude -p 'triage the private-fixture-prompt'",
      "@daily /usr/local/bin/codex exec 'summarise the private-fixture-prompt'",
      "15 4 * * * /usr/local/bin/backup --to private-fixture-bucket",
    ].map((line) => `echo "${line}"`).join("\n"),
    systemctl: `case "$*" in
  "--user list-timers"*) echo "Mon 2026-01-05 03:00:00 UTC 5h left - - nightly-review.timer nightly-review.service" ;;
  "--system list-timers"*) echo "Mon 2026-01-05 00:00:00 UTC 2h left - - logrotate.timer logrotate.service" ;;
  *"-p Unit --value nightly-review.timer") echo nightly-review.service ;;
  *"-p Unit --value logrotate.timer") echo logrotate.service ;;
  "--user show -p ExecStart --value nightly-review.service") ${exec("/usr/local/bin/codex", "exec review the private-fixture-prompt")} ;;
  *"-p ExecStart --value logrotate.service") ${exec("/usr/sbin/logrotate", "/etc/private-fixture.conf")} ;;
  "--user show -p TimersCalendar"*"nightly-review.timer") echo "{ OnCalendar=*-*-* 03:00:00 ; next_elapse=n/a }" ;;
esac`,
    // Only the two keys that hold a job's command are asked for, so no other key's value is ever read.
    plutil: `test "$1 $3 $4 $5" = "-extract xml1 -o -" || exit 2
case "$2 $6" in
  "ProgramArguments "*/triage.plist) echo "<array><string>/opt/bin/claude</string><string>-p</string><string>the private-fixture-prompt</string></array>" ;;
  "Program "*/sync.plist) echo "<string>/usr/bin/private-fixture-claude-sync</string>" ;;
  "Program "*|"ProgramArguments "*) exit 1 ;;
  *) echo "<dict><key>KEY</key><string>claude private-fixture-key</string></dict>" ;;
esac`,
    // The system's crontabs are this fixture's, not the machine's: a job the developer really runs never reaches the result.
    cat: `case "$1" in
  /etc/cron*) echo "SHELL=/bin/sh"; echo "0 5 * * * root /usr/local/bin/codex exec 'audit the private-fixture-prompt'"; echo "17 * * * * root cd / && run-parts --report /etc/private-fixture.hourly" ;;
  *) exec /bin/cat "$@" ;;
esac`,
  });
  for (const name of ["triage", "sync"]) {
    mkdirSync(join(f.dir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(f.dir, "Library", "LaunchAgents", `${name}.plist`), "");
  }
  mkdirSync(join(f.dir, ".github", "workflows"), { recursive: true });
  const workflow = (name, cron, job) => writeFileSync(join(f.dir, ".github", "workflows", name), `on:\n  schedule:\n    - cron: '${cron}'\njobs:\n  job:\n${job}`);
  workflow("nightly.yml", "0 6 * * *", "    steps:\n      - run: claude -p 'review with the private-fixture-prompt'\n        env:\n          KEY: private-fixture-key\n");
  workflow("review.yaml", "0 8 * * 1", "    steps:\n      - uses: example/codex-action@v1\n        with:\n          prompt: the private-fixture-prompt\n");
  // A workflow that only contains a runtime's name, as a test matrix of packages does, schedules no agent.
  workflow("lint.yaml", "0 7 * * *", "    strategy:\n      matrix:\n        package: [private-fixture-harness-claude, private-fixture-harness-codex]\n    steps:\n      - run: npm run private-fixture-lint\n");
  const run = f.run(step, { HOME: f.dir });
  assert.deepEqual([run.status, run.stderr], [0, ""], "it ends quietly");
  assert.deepEqual(run.stdout.split("\n").filter(Boolean), [
    "cron: 30 2 * * 1-5 claude",
    "cron: @daily codex",
    "cron: 0 5 * * * codex",
    "systemd --user: nightly-review.timer codex { OnCalendar=*-*-* 03:00:00 ; next_elapse=n/a } ",
    `launchd: ${join(f.dir, "Library", "LaunchAgents", "triage.plist")} claude`,
    "ci: .github/workflows/nightly.yml claude cron: '0 6 * * *' ",
    "ci: .github/workflows/review.yaml codex cron: '0 8 * * 1' ",
  ], "each agent job with its schedule and runtime; no other job, and none that only contains a runtime's name");
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /private-fixture/, "no prompt, key, environment value or unrelated job is returned");
});
test("the source-server skill's start step reports failure promptly and preserves its error in a private log", { timeout: 30_000 }, (t) => {
    const log = "serve.log";
    const commands = { npm: "exit 0", node: "echo 'launch failed; credential: private-fixture-value' >&2\nexit 1" };
    const f = setupFixture(t, commands);
    const run = f.run(setupRecipe());
    assert.notEqual(run.signal, "SIGTERM", `the step ended on its own: ${run.stdout}${run.stderr}`);
    assert.equal(run.status, 1, "the failed launch is not reported as success");
    assert.match(`${run.stdout}${run.stderr}`, /AgentRun did not start; inspect its private/, "it says where to diagnose the failure");
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /private-fixture-value/, "launch output is not blindly exposed");
    assert.match(readFileSync(join(f.dir, log), "utf8"), /launch failed/, "the original error remains available");
    assert.equal(statSync(join(f.dir, log)).mode & 0o777, 0o600, "the launch log is private");
});
test("the source-server setup recipe stops on failed installation or build before launching a server", (t) => {
  for (const phase of ["ci", "run"]) {
    const f = setupFixture(t, { npm: `test "$1" != "${phase}"`, node: "touch launched\nexit 1" });
    assert.equal(f.run(setupRecipe()).status, 1);
    assert.equal(existsSync(join(f.dir, "launched")), false, `${phase} failure never launches stale output`);
  }
});
test("the source-server setup recipe bounds startup and health waits while the child remains alive", { timeout: 30_000 }, (t) => {
  for (const announce of [false, true]) {
    const f = setupFixture(t, {
      npm: "exit 0",
      node: `echo $$ > child.pid\n${announce ? "echo AGENTRUN_BASE_URL=http://127.0.0.1:1/v2\n" : ""}exec /bin/sleep 30`,
      sleep: "exit 0",
      curl: "echo attempt >> health-attempts\nexit 1",
    });
    const run = f.run(setupRecipe());
    assert.equal(run.signal, null, "the bounded recipe ended on its own");
    assert.equal(run.status, 1);
    assert.match(run.stdout, announce ? /did not become healthy/ : /did not start/);
    if (announce) assert.equal(readFileSync(join(f.dir, "health-attempts"), "utf8").trim().split("\n").length, 60);
  }
});

// npx runs the command through `npm exec`, which runs it through `sh -c`. A signal to npm alone (a process manager's
// SIGTERM or SIGKILL) ended npm and left the command, and the server, with nobody to stop them. Now, started by npm exec,
// the command watches that npm and stops the server when npm goes. Started any other way it watches nothing: a shell that
// backgrounds it and exits (`&`, nohup, a tool call's shell) leaves it running, as a shell's rules say. A SIGHUP to the
// command alone asks the server to stop, as a SIGTERM does.
const NPM_ENV = { npm_command: "exec", npm_lifecycle_event: "npx", npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" };
const strip = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !/^npm_/i.test(name)));
async function healthUntil(base, wanted, tries) {
  for (let i = 0; i < tries; i++) {
    const up = await fetch(`${base}/v2/health`).then((r) => r.ok, () => false);
    if (up === wanted) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
// PIDs wrap in minutes on a busy machine, so a number read from a file or kept from earlier may be another process's by
// now. These tests signal a pid only after reading, in the same step, that it still runs what the test started there
// (`marker` in its command line), and a process group only when the test made it with setsid and one of its processes
// still runs the test's command.
/** A process's command line, or undefined once it is gone: whole (`-ww`), as ps cuts it to 80 columns when its output is no
 *  terminal, which would cut off the marker. */
const commandLine = (pid) => {
  try { return execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
};
/** Signals `pid` only while it runs `marker`. */
function killIf(pid, marker, signal = "SIGKILL") {
  if (pid && commandLine(pid)?.includes(marker)) try { process.kill(pid, signal); } catch {}
}
/** Whether `pid` no longer runs `marker` (gone, or its number another's), within 10 s. */
async function gone(pid, marker) {
  for (let i = 0; i < 100; i++) {
    if (!commandLine(pid)?.includes(marker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
/** A process group this test made with setsid (spawn's `detached`), checked as one now (its pgid is its pid); the kill
 *  takes it down only while one of its processes still runs `marker`. */
function ownGroup(child, marker) {
  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
  assert.equal(pgid, child.pid, "the test's process leads a group of its own");
  return () => {
    const members = execFileSync("ps", ["-ww", "-A", "-o", "pgid=,args="], { encoding: "utf8" }).split("\n").filter((line) => Number(line.trim().split(/\s+/)[0]) === pgid);
    if (members.some((line) => line.includes(marker))) try { process.kill(-pgid, "SIGKILL"); } catch {}
  };
}
/** npm as npx runs the command: it names itself `npm exec …` and runs the command through a waiting `sh -c`, in a group
 *  of its own. */
function asNpx(t, bin, env) {
  const npm = spawn(process.execPath, ["-e", `process.title = "npm exec agentrun --no-open"; const c = require("node:child_process").spawn("sh", ["-c", ${JSON.stringify(`"${process.execPath}" "${bin}" --no-open; :`)}], { stdio: "inherit" }); c.on("exit", (code) => process.exit(code ?? 1)); setInterval(() => {}, 1000);`], { env: { ...env, ...NPM_ENV }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  t.after(ownGroup(npm, bin));
  return npm;
}

test("started by npm exec, the command stops the server once that npm is gone, though the shell npm started it with waits on", { timeout: 90_000 }, async (t) => {
  const { env } = bare(t);
  const npm = asNpx(t, BIN, strip(env));
  let out = "";
  npm.stdout.on("data", (chunk) => (out += chunk));
  for (let i = 0; !out.includes("\n") && i < 600; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const base = /^AgentRun is running at (http:\/\/127\.0\.0\.1:\d+)\//.exec(out)?.[1];
  assert.ok(base, `the command started: ${out}`);
  // Only npm goes, as with a SIGKILL to it; its shell and the command are left.
  npm.kill("SIGKILL");
  assert.ok(await healthUntil(base, false, 300), "the server stopped within 30 s of npm ending");
});

/** This package with a stub server installed beside it, as its dependency is: the stub records its pid, prints the
 *  server's lines, runs one agent child that counts the SIGTERMs it gets, and on a SIGTERM stops that agent once and
 *  waits for it, as the server's own close drains its runs. */
function stubbedSetup(t) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-stubbed-"));
  for (const part of ["bin", "lib", "package.json"]) cpSync(join(PACKAGE, part), join(dir, "pkg", part), { recursive: true });
  const serve = join(dir, "pkg", "node_modules", "@parcha", "agentrun-serve");
  mkdirSync(join(serve, "launcher"), { recursive: true });
  writeFileSync(join(serve, "package.json"), JSON.stringify({ name: "@parcha/agentrun-serve", version: SERVE_VERSION }));
  const files = { server: join(dir, "server.json"), terms: join(dir, "agent.terms"), agentPid: join(dir, "agent.pid") };
  const stub = join(serve, "launcher", "agentrun-serve");
  writeFileSync(stub, `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(files.server)}, JSON.stringify({ argv, pid: process.pid, ppid: process.ppid }));
const agent = spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(files.agentPid)}, String(process.pid)); process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(files.terms)}, "TERM\\n"); setTimeout(() => process.exit(0), 500); }); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
console.log("agentrun-serve on http://127.0.0.1:7399/v2 (stub)");
console.log("Open http://127.0.0.1:7399/");
process.on("SIGTERM", () => { agent.kill("SIGTERM"); agent.on("exit", () => process.exit(0)); });
setInterval(() => {}, 1000);
`);
  chmodSync(stub, 0o755);
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
  // One hook, in this order: what the stub started, each signalled only while it still runs the stub or the agent's
  // script (their pids are in the files), then the files. A stub left running would hold the test's stderr open.
  t.after(() => {
    const server = read(files.server);
    if (server) killIf(JSON.parse(server).pid, stub);
    const agent = read(files.agentPid);
    if (agent) killIf(Number(agent), files.agentPid);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, files, stub, bin: join(dir, "pkg", "bin", "agentrun.mjs") };
}
async function startStubbed(t, setup) {
  const { env } = bare(t);
  const child = spawn(process.execPath, [setup.bin, "--no-open"], { env: strip(env), stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !out.includes("\n") && i < 300 && child.exitCode === null; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const server = existsSync(setup.files.server) ? JSON.parse(readFileSync(setup.files.server, "utf8")) : null;
  return { child, exited, out: () => out, err: () => err, server };
}

test("a SIGTERM or a SIGHUP to the command stops the server, which stops each running agent once", { timeout: 90_000 }, async (t) => {
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    const setup = stubbedSetup(t);
    const run = await startStubbed(t, setup);
    assert.ok(run.server, `the server ran: ${run.out()}${run.err()}`);
    for (let i = 0; !existsSync(setup.files.agentPid) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    run.child.kill(signal);
    await Promise.race([run.exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    assert.ok(await gone(run.server.pid, setup.stub), `${signal}: the server stopped`);
    assert.ok(await gone(Number(readFileSync(setup.files.agentPid, "utf8")), setup.files.agentPid), `${signal}: its agent stopped`);
    assert.equal(readFileSync(setup.files.terms, "utf8"), "TERM\n", `${signal}: the agent got one SIGTERM, the server's, and drained`);
  }
});

test("a first word that is neither a command of the CLI nor one of the server's is the CLI's: it says there is no such command and lists the commands, exit 2; the server is not started", (t) => {
  const { env } = bare(t);
  const run = spawnSync(process.execPath, [BIN, "frobnicate"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /^agentrun has no command frobnicate\.$/m);
  assert.match(run.stderr, /^ {2}runs +.*\bstart\b/m, "and the commands");
  assert.doesNotMatch(run.stderr, /agentrun-serve/, "not the server's usage");
  assert.equal(run.stdout, "");
});

test("the server's own commands the bin passes on are exactly those the server's CLI has", () => {
  const source = readFileSync(new URL("../../serve/src/cli.ts", import.meta.url), "utf8");
  const own = [...source.matchAll(/process\.argv\[2\] === "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...start.SERVER_COMMANDS].sort(), [...new Set(own)].sort());
});

test("the public launcher forwards native discovery without starting a server or asking for a model key", (t) => {
  const {env}=bare(t);
  const project=mkdtempSync(join(tmpdir(),'agentrun-native-launcher-'));removeAtEnd(project);
  writeFileSync(join(project,'AGENTS.md'),'Keep existing native project instructions.\n');
  const result=spawnSync(process.execPath,[BIN,'native','discover','--project',project,'--runtime','codex'],{env,encoding:'utf8',timeout:30_000});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.targets[0].project,project);assert.equal(report.targets[0].runtime,'codex');
  assert.doesNotMatch(result.stderr,/model key|API key|running at/);
});

test("the server's refusals and ignored webhook deliveries reach the person in plain words, route and reason, each once; nothing else of its log does", () => {
  const told = start.tellerOf();
  assert.equal(told("at=2026-11-08T20:00:00.000Z event=auth_failed route=/v2/agents reason=wrong_token"), "AgentRun refused a request to /v2/agents: the API token is not this server's. (Each route and reason is said once.)");
  assert.equal(told("at=2026-11-08T20:00:01.000Z event=auth_failed route=/v2/agents reason=wrong_token"), undefined, "the same refusal again is not said again");
  assert.equal(told("at=2026-11-08T20:00:02.000Z event=auth_failed route=/v2/agents reason=no_credential"), "AgentRun refused a request to /v2/agents: it carried no API token.");
  assert.equal(told('at=2026-11-08T20:00:03.000Z event=auth_failed route=/hooks/trg_1 reason=bad_signature'), "AgentRun refused a request to /hooks/trg_1: bad_signature.");
  assert.equal(told("at=2026-11-08T20:00:04.000Z event=trigger condition=hook_ignored source=github route=/hooks/trg_2 trigger=trg_2 reason=event_not_taken event=star"), "AgentRun ignored a webhook delivery to /hooks/trg_2 (github, event star): event_not_taken.");
  assert.equal(told("at=2026-11-08T20:00:05.000Z event=trigger condition=hook_unparsed source=github route=/hooks/trg_2"), undefined);
  assert.equal(told("at=2026-11-08T20:00:06.000Z event=request method=GET route=/v2/agents status=401"), undefined);
  assert.equal(told("Boxes: none is ready, so sandbox agents do not run here."), undefined, "the SAID lines are said by their own rule");
  // A server under a flood of refusals: a bounded number of distinct ones, then one line that says the rest are not.
  const flood = start.tellerOf();
  const said = Array.from({ length: start.TOLD_MAX + 5 }, (_, i) => flood(`at=x event=auth_failed route=/v2/runs/r${i} reason=wrong_token`)).filter(Boolean);
  assert.equal(said.length, start.TOLD_MAX + 1);
  assert.equal(said.at(-1), "AgentRun refuses more requests than this terminal shows; it says no more of them here.");
});

test("a ChatGPT sign-in that did not finish reaches the person, each time, with its reason; the sign-in's other lines do not", () => {
  const told = start.tellerOf();
  const failed = "at=2026-11-23T18:00:00.000Z event=chatgpt chatgpt=sign_in_failed reason=token_400_invalid_grant";
  const words = "AgentRun's ChatGPT sign-in did not finish (token_400_invalid_grant): Settings → API Keys says why; start it again there.";
  assert.equal(told(failed), words);
  assert.equal(told(failed), words, "a second try that fails the same way is said too");
  assert.equal(told("at=2026-11-23T18:00:01.000Z event=chatgpt chatgpt=signed_in"), undefined);
  // Under a flood of refusals, a sign-in that fails is still said.
  for (let i = 0; i <= start.TOLD_MAX; i++) told(`at=x event=auth_failed route=/v2/runs/r${i} reason=wrong_token`);
  assert.equal(told(failed), words);
  // A sign-in saved whose change the server failed to take is said too: what it offers lags until it takes.
  assert.equal(told("at=2026-11-23T18:00:02.000Z event=chatgpt chatgpt=changed_failed reason=SQLITE_BUSY"), "AgentRun saved the ChatGPT sign-in but has not taken it into what it offers yet (SQLITE_BUSY): it tries again as Settings reads it; if codex and pi still ask for a key, restart AgentRun.");
});

test("started, the bin says a refused request on stderr; stdout stays the one running line", { timeout: 120_000 }, async (t) => {
  const { env } = bare(t);
  const child = spawn(process.execPath, [BIN, "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => stopChild(child, exited));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !/^AgentRun is running at /.test(out); i++) {
    assert.ok(i < 1000, `the bin printed its line: ${out}${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const base = /^AgentRun is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
  assert.equal((await fetch(`${base}/v2/agents`, { headers: { authorization: "Bearer not-this-servers" } })).status, 401);
  for (let i = 0; !/refused a request/.test(err); i++) {
    assert.ok(i < 300, `the refusal was said: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(err, /^AgentRun refused a request to \/v2\/agents: the API token is not this server's\./m);
  assert.doesNotMatch(err, /not-this-servers/, "never the token sent");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, err);
  assert.equal(out.split("\n").filter(Boolean).length, 1, "nothing more on stdout");
});

test("public learning connection verbs reach the local installer while existing learning API verbs still work", (t) => {
  const {env} = bare(t);
  const project = mkdtempSync(join(tmpdir(), "agentrun-learning-launch-project-"));
  const data = mkdtempSync(join(tmpdir(), "agentrun-learning-launch-data-"));
  t.after(() => { rmSync(project, {recursive:true,force:true}); rmSync(data, {recursive:true,force:true}); });
  const local = spawnSync(process.execPath, [BIN, "learning", "status", "--runtime", "codex", "--project", project, "--data", data], {env,encoding:"utf8",timeout:30_000});
  assert.equal(local.status, 0, local.stderr);
  assert.equal(JSON.parse(local.stdout).state, "not-installed");
  for (const verb of ["connect", "status", "disconnect", "retry", "hook"]) {
    const help = spawnSync(process.execPath, [BIN, "learning", verb, "--help"], {env,encoding:"utf8",timeout:30_000});
    assert.ifError(help.error);
    assert.equal(help.status, 0, `${verb}: ${help.stderr}`);
    assert.match(help.stdout, /usage: agentrun-serve learning/);
    assert.match(help.stdout, /--runtime codex\|claude-code/);
  }
  const api = spawnSync(process.execPath, [BIN, "learning", "corrections", "--help"], {env,encoding:"utf8",timeout:30_000});
  assert.equal(api.status, 0, api.stderr);
  assert.match(api.stdout, /corrections/);
  assert.doesNotMatch(api.stdout, /server command/);
});
