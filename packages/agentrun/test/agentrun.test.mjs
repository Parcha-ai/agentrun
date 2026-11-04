// `npx @parcha/agentrun`: the bin runs AgentRun Server, its dependency at its exact version, with the arguments it was given,
// its data in ~/.agentrun unless --data names another, and the browser opened unless --no-open; the server picks the port
// and the model a key gives. The bin prints the console's address on one line, and a subcommand goes to the server's own
// CLI. With no model key the server starts and says it has no model, and the console asks for its first password. npm
// exec of the packed package runs this bin.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as start from "../lib/start.mjs";
import { openLineUrl, openUrl } from "../lib/start.mjs";

const PACKAGE = new URL("..", import.meta.url).pathname;
const BIN = join(PACKAGE, "bin", "agentrun.mjs");
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
const VERSION = MANIFEST.version;
const SERVE_VERSION = JSON.parse(readFileSync(new URL("../../serve/package.json", import.meta.url), "utf8")).version;
/** This command's store, under the fresh home `bare` makes: ~/.agentrun, handed to the server as --data. */
const STORE = (home) => join(home, ".agentrun");
/** The server's own default store (agentrun-serve with no --data), which this command never uses. */
const SERVE_STORE = (home) => join(home, ".local", "share", "agentrun", "agents");
const MODEL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENTRUN_TOKEN"];

/** This environment with a fresh home, no model key, and no browser. */
function bare(t) {
  const home = mkdtempSync(join(tmpdir(), "agentrun-npx-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !MODEL_KEYS.includes(name)));
  return { home, env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), CI: "1" } };
}

test("demo: with no model key, the bin starts on a free loopback port and prints one line, the address the server says to open; the server has no model and the console asks for its first password", { timeout: 120_000 }, async (t) => {
  const { home, env } = bare(t);
  const child = spawn(process.execPath, [BIN], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(async () => { child.kill("SIGTERM"); await exited; });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !out.includes("\n"); i++) {
    assert.ok(i < 1000, `the bin printed its line: ${out}${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const match = /^AgentRun is running at (http:\/\/127\.0\.0\.1:(\d+))\/\S*\n$/.exec(out);
  assert.ok(match, `one line, the server's address to open, on loopback: ${JSON.stringify(out)}`);
  assert.ok(Number(match[2]) >= 7340, "the server's first free port from its default");
  const base = match[1];
  const health = await fetch(`${base}/v2/health`);
  assert.deepEqual([health.status, (await health.json()).status], [200, "ok"]);
  assert.equal((await (await fetch(`${base}/v2/capabilities`)).json()).models.default, null, "no model: none was given");
  // Until a single-use sign-in link replaces the plain address, the console's first visit sets the owner's password.
  assert.deepEqual(await (await fetch(`${base}/v2/auth/session`)).json(), { password_set: false, signed_in: false });
  assert.ok(existsSync(join(STORE(home), ".token")), "the data directory is ~/.agentrun");
  assert.equal(existsSync(SERVE_STORE(home)), false, "no second store");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, err);
  assert.equal(out.split("\n").filter(Boolean).length, 1, "nothing more on stdout");
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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
async function throughStub(t, args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-stub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const part of ["bin", "lib", "package.json"]) cpSync(join(PACKAGE, part), join(dir, "pkg", part), { recursive: true });
  const serve = join(dir, "pkg", "node_modules", "@parcha", "agentrun-serve");
  mkdirSync(join(serve, "launcher"), { recursive: true });
  writeFileSync(join(serve, "package.json"), JSON.stringify({ name: "@parcha/agentrun-serve", version: SERVE_VERSION }));
  const served = join(dir, "served.json");
  writeFileSync(join(serve, "launcher", "agentrun-serve"), `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(served)}, JSON.stringify({ args: process.argv.slice(2), npx: process.env.AGENTRUN_NPX_PACKAGE, model: process.env.AGENT_MODEL ?? null }));
if (process.argv[2] === "import") process.exit(0);
console.log("agentrun-serve on http://127.0.0.1:7399/v2 (stub)");
console.log("Open http://127.0.0.1:7399/");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
  chmodSync(join(serve, "launcher", "agentrun-serve"), 0o755);
  const { home, env: base } = bare(t);
  const child = spawn(process.execPath, [join(dir, "pkg", "bin", "agentrun.mjs"), ...args], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(async () => { child.kill("SIGTERM"); await exited; });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !out.includes("\n") && child.exitCode === null && i < 300; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill("SIGTERM");
  return { home, out, err, code: await exited, ...(existsSync(served) ? JSON.parse(readFileSync(served, "utf8")) : {}) };
}

test("the command passes its arguments through to the server, with its store (~/.agentrun unless --data names one) and --open unless --no-open; it picks no port or model of its own", { timeout: 60_000 }, async (t) => {
  const plain = await throughStub(t, [], { ANTHROPIC_API_KEY: "sk-test" });
  assert.deepEqual([plain.args, plain.model, plain.npx], [["--open", "--data", STORE(plain.home)], null, `@parcha/agentrun@${VERSION}`], plain.err);
  assert.equal(plain.out, "AgentRun is running at http://127.0.0.1:7399/\n");
  assert.equal(plain.code, 0, plain.err);
  const given = await throughStub(t, ["--no-open", "--port", "7400", "--data", "/srv/agents"]);
  assert.deepEqual(given.args, ["--data", "/srv/agents", "--port", "7400"], given.err);
  const sub = await throughStub(t, ["--data", "/srv/agents", "import", "--dry-run"]);
  assert.deepEqual(sub.args, ["import", "--data", "/srv/agents", "--dry-run"], "a subcommand first, on the same data directory");
  const own = await throughStub(t, ["import", "--dry-run"]);
  assert.deepEqual(own.args, ["import", "--data", STORE(own.home), "--dry-run"], "a subcommand on ~/.agentrun");
});

test("with the server missing from beside it, the command says so in one line and exits 1", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-alone-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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

test("an Open line's URL is its first word, an http(s) URL on the server's loopback address; nothing else is", () => {
  assert.equal(openLineUrl("Open http://127.0.0.1:7340/"), "http://127.0.0.1:7340/");
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
test("on Node 20 the bin says, in one line, which Node it needs, and exits 1 before it loads anything", () => {
  for (const node of ["20.20.0", "22.18.0", "23.11.0", "24.1.0"]) {
    const fake = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process, "versions", { value: { ...process.versions, node: "${node}" } });`)}`;
    const run = spawnSync(process.execPath, ["--import", fake, BIN, "--help"], { encoding: "utf8" });
    assert.deepEqual([run.status, run.stdout, run.stderr], [1, "", `AgentRun needs Node.js 22.19 or newer on 22, or 24.2 or newer; you have v${node}.\n`], node);
  }
});

// docs/SKILL.md's start step, as a coding agent runs it: when the command fails, the step ends and says why, never waits.
test("the setup skill's start step ends with the command's error when it fails, and does not wait forever", { timeout: 30_000 }, () => {
  const skill = readFileSync(new URL("../../../docs/SKILL.md", import.meta.url), "utf8");
  const step = /## 2\. Start it\n\n```sh\n([\s\S]*?)```/.exec(skill)?.[1];
  assert.ok(step, "the skill has its start step");
  const dir = mkdtempSync(join(tmpdir(), "agentrun-skill-"));
  try {
    mkdirSync(join(dir, "fake"));
    writeFileSync(join(dir, "fake", "npx"), "#!/bin/sh\necho 'npm error 404 Not Found - @parcha/agentrun' >&2\nexit 1\n");
    chmodSync(join(dir, "fake", "npx"), 0o755);
    const run = spawnSync("sh", ["-c", step], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: `${join(dir, "fake")}:${process.env.PATH}` } });
    assert.notEqual(run.signal, "SIGTERM", `the step ended on its own: ${run.stdout}${run.stderr}`);
    assert.match(`${run.stdout}${run.stderr}`, /npm error 404 Not Found/, "it shows the command's error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("started directly by a shell that backgrounds it and exits, the command keeps the server running", { timeout: 90_000 }, async (t) => {
  const { env, home } = bare(t);
  const log = join(home, "agentrun.log");
  const pidFile = join(home, "agentrun.pid");
  // No npm here: the shell starts it in the background, writes its pid, and is gone a little later, once the command is up
  // and has taken the shell for its parent (as a tool call's shell does).
  const shell = spawnSync("sh", ["-c", `"${process.execPath}" "${BIN}" --no-open > "${log}" 2>&1 & echo $! > "${pidFile}"; sleep 2`], { env: strip(env) });
  assert.equal(shell.status, 0);
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => killIf(pid, BIN, "SIGTERM"));
  let base;
  for (let i = 0; !base && i < 600; i++) {
    base = /^AgentRun is running at (http:\/\/127\.0\.0\.1:\d+)\//.exec(existsSync(log) ? readFileSync(log, "utf8") : "")?.[1];
    if (!base) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(base, "the command started");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.ok(await healthUntil(base, true, 10), "the server is still up 3 s after the shell that started it ended");
  killIf(pid, BIN, "SIGTERM");
  assert.ok(await healthUntil(base, false, 300), "and stops when its command is stopped");
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
