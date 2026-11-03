// `npx @parcha/agentrun`: the bin starts AgentRun Server on a free loopback port with its data in ~/.agentrun, prints the
// console's address on one line, and a subcommand goes to the server's own CLI. With no model key the server starts and
// says it has no model, and the console asks for its first password. npm exec of the packed package runs this bin.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_PORT, FETCH, freePort, KEY_MODELS, modelEnv, openLineUrl, openUrl, server, shouldOpen } from "../lib/start.mjs";

const PACKAGE = new URL("..", import.meta.url).pathname;
const BIN = join(PACKAGE, "bin", "agentrun.mjs");
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
  assert.ok(Number(match[2]) >= DEFAULT_PORT);
  const base = match[1];
  const health = await fetch(`${base}/v2/health`);
  assert.deepEqual([health.status, (await health.json()).status], [200, "ok"]);
  assert.equal((await (await fetch(`${base}/v2/capabilities`)).json()).models.default, null, "no model: none was given");
  // The browser opens on the console, whose first visit sets the owner's password.
  assert.deepEqual(await (await fetch(`${base}/v2/auth/session`)).json(), { password_set: false, signed_in: false });
  assert.ok(existsSync(join(home, ".agentrun", ".token")), "the data directory is ~/.agentrun");
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
  assert.equal(existsSync(join(home, ".agentrun", ".token")), false, "a dry run writes nothing");
});

test("npm exec of the packed package runs this package's own agentrun bin", { timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // npm's own settings from the npm that runs this suite (a workspace, a -c command) are not this npm's.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
  const npm = (args) => execFileSync("npm", args, { cwd: dir, encoding: "utf8", env: { ...clean, npm_config_cache: join(dir, "cache"), npm_config_update_notifier: "false" } });
  const tarball = npm(["pack", PACKAGE, "--pack-destination", dir, "--silent"]).trim().split("\n").at(-1);
  const out = npm(["exec", "--offline", "--yes", `--package=file:${join(dir, tarball)}`, "--", "agentrun", "--help"]);
  assert.match(out, /^Usage: npx @parcha\/agentrun /);
});

test("an installed server runs its own launcher; with none, npm exec fetches the server's latest release and names its own bin, never this package's", () => {
  const missing = () => { throw new Error("not installed"); };
  assert.deepEqual(server(["--port", "7340"], missing), { command: undefined, args: ["--port", "7340"], fetched: true });
  assert.deepEqual(FETCH, ["exec", "--yes", "--package=@parcha/agentrun-serve@latest", "--", "sh", "-c", "command -v agentrun-serve"]);
  const installed = () => join("/opt", "app", "node_modules", "@parcha", "agentrun-serve", "package.json");
  assert.deepEqual(server(["import"], installed), { command: join("/opt", "app", "node_modules", "@parcha", "agentrun-serve", "launcher", "agentrun-serve"), args: ["import"], fetched: false });
  assert.ok(existsSync(new URL("../../serve/launcher/agentrun-serve", import.meta.url)), "the server ships the launcher this runs");
});

test("a provider key picks the server's model when none is set, the first of Anthropic, OpenAI and OpenRouter; a model or a gateway already set wins; each is in pi-ai's catalog", () => {
  assert.deepEqual(modelEnv({ OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" }), { AGENT_MODEL: "anthropic/claude-sonnet-5-5" });
  assert.deepEqual(modelEnv({ OPENAI_API_KEY: "k" }), { AGENT_MODEL: "openai/gpt-6.1-sol" });
  assert.deepEqual(modelEnv({ OPENROUTER_API_KEY: "k" }), { AGENT_MODEL: "openrouter/anthropic/claude-sonnet-5.5" });
  assert.deepEqual(modelEnv({ ANTHROPIC_API_KEY: "k", AGENT_MODEL: "openai/gpt-5" }), {});
  assert.deepEqual(modelEnv({ OPENAI_API_KEY: "k", AGENT_MODEL_BASE_URL: "https://gateway.example/v1" }), {});
  const models = builtinModels({});
  for (const [, ref] of KEY_MODELS) assert.ok(models.getModel(ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)), ref);
});

test("the first free loopback port from the default passes over one in use; the browser opens unless --no-open, CI or no display", async (t) => {
  const first = await freePort();
  const held = createServer();
  await new Promise((resolve) => held.listen(first, "127.0.0.1", resolve));
  t.after(() => held.close());
  assert.ok((await freePort(first)) > first);
  assert.deepEqual([shouldOpen([], {}, "darwin"), shouldOpen(["--no-open"], {}, "darwin"), shouldOpen([], { CI: "1" }, "darwin"), shouldOpen([], {}, "linux"), shouldOpen([], { DISPLAY: ":0" }, "linux")], [true, false, false, false, true]);
});

// A stub server: its output as the server prints it, a line at a time, then it waits. The command takes the URL of the first
// "Open " line, whatever it is: its first word, a URL with a path or a query taken as it is.
const stub = (lines, { exit = false } = {}) => spawn(process.execPath, ["-e", `const lines = ${JSON.stringify(lines)}; let i = 0; const next = () => { if (i < lines.length) { process.stdout.write(lines[i++]); setTimeout(next, 20); } else if (${exit}) process.exit(0); else setInterval(() => {}, 1000); }; next();`], { stdio: ["ignore", "pipe", "inherit"] });

test("the address to open is the URL on the server's first \"Open \" line, however its output is cut; a later Open line, and the lines around it, change nothing", async (t) => {
  const plain = stub(["agentrun-serve on http://127.0.0.1:7341/v2 (agent store in /tmp/x)\nAGENTRUN_BASE_URL=http://127.0.0.1:7341/v2\nOp", "en http://127.0.0.1:7341/\n", "Open http://127.0.0.1:7341/other\nGET /v2/health 200\n"]);
  t.after(() => plain.kill());
  assert.equal(await openUrl(plain.stdout), "http://127.0.0.1:7341/");
  const link = stub(["agentrun-serve on http://127.0.0.1:7342/v2\r\n", "Open http://127.0.0.1:7342/pair?code=Q7-2x (signs this browser in, once)\r\n"]);
  t.after(() => link.kill());
  assert.equal(await openUrl(link.stdout), "http://127.0.0.1:7342/pair?code=Q7-2x", "a URL with a path and a query is taken as it is, without the words after it");
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

// The headline path: `npx @parcha/agentrun` with no server installed beside it. The command fetches the server with
// `npm exec`, naming the package with --package and running its bin after `--`: without --package, npm takes the bin from
// the package spec and hands the server "agentrun-serve" as an argument, which it refuses. A fake npm first on PATH
// records its argv and, as npm would, runs a stub server that prints its "Open " line.
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
// the command watches that npm and stops the server when it is gone. Started any other way it watches nothing: a shell
// that backgrounds it and exits (`&`, nohup, a tool call's shell) leaves it running, as a shell's rules say.
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

test("started by npm exec, the command stops the server once that npm is gone, though the shell npm started it with waits on", { timeout: 90_000 }, async (t) => {
  const { env } = bare(t);
  // npm as npx runs it: it names itself `npm exec …` and runs the command through a waiting `sh -c`.
  const npm = spawn(process.execPath, ["-e", `process.title = "npm exec agentrun --no-open"; const c = require("node:child_process").spawn("sh", ["-c", ${JSON.stringify(`"${process.execPath}" "${BIN}" --no-open; :`)}], { stdio: "inherit" }); c.on("exit", (code) => process.exit(code ?? 1)); setInterval(() => {}, 1000);`], { env: { ...strip(env), ...NPM_ENV }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  t.after(() => { try { process.kill(-npm.pid, "SIGKILL"); } catch {} });
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
  t.after(() => { try { process.kill(pid, "SIGTERM"); } catch {} });
  let base;
  for (let i = 0; !base && i < 600; i++) {
    base = /^AgentRun is running at (http:\/\/127\.0\.0\.1:\d+)\//.exec(existsSync(log) ? readFileSync(log, "utf8") : "")?.[1];
    if (!base) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(base, "the command started");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.ok(await healthUntil(base, true, 10), "the server is still up 3 s after the shell that started it ended");
  process.kill(pid, "SIGTERM");
  assert.ok(await healthUntil(base, false, 300), "and stops when its command is stopped");
});

// With no server beside it, the command has npm exec install the server's latest release, as npx does, and name its bin.
// The command then runs that server itself, so nothing stands between them: a stop (its own signal, or its npm watch)
// reaches the server, which drains each running agent once.
/** This package alone (no installed server resolves from it), an `npm` on PATH that installs nothing but names a stub
 *  server's path, and the stub: it records its arguments, environment and parent, prints the server's lines, runs one
 *  agent child that counts the SIGTERMs it gets, and on a SIGTERM stops that agent once and waits for it, as the server's
 *  own close drains its runs. */
function fetchedSetup(t, { fetchMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-fetch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const part of ["bin", "lib", "package.json"]) cpSync(join(PACKAGE, part), join(dir, "pkg", part), { recursive: true });
  mkdirSync(join(dir, "fake"));
  const files = { npm: join(dir, "npm.json"), server: join(dir, "server.json"), terms: join(dir, "agent.terms"), agentPid: join(dir, "agent.pid") };
  const stub = join(dir, "agentrun-serve");
  writeFileSync(stub, `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(files.server)}, JSON.stringify({ argv, command: process.env.AGENTRUN_COMMAND, pid: process.pid, ppid: process.ppid }));
const agent = spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(files.agentPid)}, String(process.pid)); process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(files.terms)}, "TERM\\n"); setTimeout(() => process.exit(0), 500); }); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
const port = argv[argv.indexOf("--port") + 1];
console.log("agentrun-serve on http://127.0.0.1:" + port + "/v2 (stub)");
console.log("Open http://127.0.0.1:" + port + "/");
process.on("SIGTERM", () => { agent.kill("SIGTERM"); agent.on("exit", () => process.exit(0)); });
setInterval(() => {}, 1000);
`);
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "fake", "npm"), `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(files.npm)}, JSON.stringify({ argv: process.argv.slice(2), leaked: Object.keys(process.env).filter((name) => /^npm_config_(call|workspaces?|include_workspace_root)$/i.test(name)) }));
// The fetch takes ${fetchMs} ms, as a first run's download does.
setTimeout(() => console.log(${JSON.stringify(stub)}), ${fetchMs});
`);
  chmodSync(join(dir, "fake", "npm"), 0o755);
  return { dir, files, bin: join(dir, "pkg", "bin", "agentrun.mjs"), path: join(dir, "fake") };
}
async function startFetched(t, setup, extraEnv = {}) {
  const { env } = bare(t);
  const child = spawn(process.execPath, [setup.bin, "--no-open"], { env: { ...strip(env), ...extraEnv, PATH: `${setup.path}:${env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !out.includes("\n") && i < 300 && child.exitCode === null; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const server = existsSync(setup.files.server) ? JSON.parse(readFileSync(setup.files.server, "utf8")) : null;
  for (const pid of [server?.pid, existsSync(setup.files.agentPid) ? Number(readFileSync(setup.files.agentPid, "utf8")) : undefined]) {
    if (pid) t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  }
  return { child, exited, out: () => out, err: () => err, server };
}
const gone = async (pid) => {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

test("with no server beside it, npm exec installs the server's latest release and names its bin; the command runs that server itself, with only its own arguments", { timeout: 60_000 }, async (t) => {
  const setup = fetchedSetup(t);
  // Started from inside another npm command (`npm exec -c …`, a workspace), whose settings npm hands down in its environment.
  const outer = { npm_config_call: "node --test", npm_config_workspace: "@parcha/agentrun", npm_config_workspaces: "true" };
  const run = await startFetched(t, setup, outer);
  const npm = JSON.parse(readFileSync(setup.files.npm, "utf8"));
  const at = npm.argv.indexOf("--");
  assert.ok(npm.argv.indexOf("--package=@parcha/agentrun-serve@latest") >= 0 && npm.argv.indexOf("--package=@parcha/agentrun-serve@latest") < at, `--package names the server before --: ${JSON.stringify(npm.argv)}`);
  assert.deepEqual(npm.argv.slice(at + 1), ["sh", "-c", "command -v agentrun-serve"], "npm exec names the server's bin, and runs nothing else");
  assert.deepEqual(npm.leaked, [], "an outer npm's -c command and workspace do not reach this npm exec");
  assert.ok(run.server, `the server ran: ${run.out()}${run.err()}`);
  assert.equal(run.server.argv[0], "--data");
  assert.ok(!run.server.argv.includes("agentrun-serve"), `the server gets no stray argument: ${JSON.stringify(run.server.argv)}`);
  assert.equal(run.server.command, "agentrun", "the server is told this command started it, for the install line it gives");
  assert.equal(run.server.ppid, run.child.pid, "the server is this command's own child: no npm between them");
  assert.match(run.out(), /^AgentRun is running at http:\/\/127\.0\.0\.1:\d+\/\n$/, `${run.out()}${run.err()}`);
  run.child.kill("SIGTERM");
  assert.equal(await run.exited, 0, run.err());
});

test("with no server beside it, a SIGTERM or a SIGHUP to the command stops the server, which stops each running agent once", { timeout: 90_000 }, async (t) => {
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    const setup = fetchedSetup(t);
    const run = await startFetched(t, setup);
    assert.ok(run.server, `the server ran: ${run.out()}${run.err()}`);
    for (let i = 0; !existsSync(setup.files.agentPid) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    run.child.kill(signal);
    await Promise.race([run.exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    assert.ok(await gone(run.server.pid), `${signal}: the server stopped`);
    assert.ok(await gone(Number(readFileSync(setup.files.agentPid, "utf8"))), `${signal}: its agent stopped`);
    if (signal === "SIGTERM") assert.equal(readFileSync(setup.files.terms, "utf8"), "TERM\n", "the agent got one SIGTERM, the server's, and drained");
  }
});

test("started by npm exec with no server beside it, an npm gone while the server is fetched starts no server", { timeout: 90_000 }, async (t) => {
  const setup = fetchedSetup(t, { fetchMs: 3000 });
  const { env } = bare(t);
  // npm as npx runs it, naming itself `npm exec …`, its `sh -c` waiting on the command.
  const npm = spawn(process.execPath, ["-e", `process.title = "npm exec agentrun --no-open"; const c = require("node:child_process").spawn("sh", ["-c", ${JSON.stringify(`"${process.execPath}" "${setup.bin}" --no-open; :`)}], { stdio: "inherit" }); c.on("exit", (code) => process.exit(code ?? 1)); setInterval(() => {}, 1000);`], { env: { ...strip(env), ...NPM_ENV, PATH: `${setup.path}:${env.PATH}` }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  t.after(() => { try { process.kill(-npm.pid, "SIGKILL"); } catch {} });
  // The fetch has begun: then only npm goes, as with a SIGKILL to it.
  for (let i = 0; !existsSync(setup.files.npm) && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(setup.files.npm), "the fetch began");
  npm.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const server = existsSync(setup.files.server) ? JSON.parse(readFileSync(setup.files.server, "utf8")) : null;
  if (server) t.after(() => { try { process.kill(server.pid, "SIGKILL"); } catch {} });
  assert.equal(server, null, "no server started once npm was gone");
});
