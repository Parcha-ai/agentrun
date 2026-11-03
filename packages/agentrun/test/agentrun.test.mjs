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

// The command passes its arguments through: the server's CLI picks the port, the model a key gives and opens the browser.
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

test("demo: with a provider key and no model, the server the command starts runs a current model of that provider", { timeout: 120_000 }, async (t) => {
  const { env } = bare(t);
  const child = spawn(process.execPath, [BIN, "--no-open"], { env: { ...env, ANTHROPIC_API_KEY: "not-a-secret" }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(async () => { child.kill("SIGTERM"); await exited; });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !out.includes("\n"); i++) {
    assert.ok(i < 1000 && child.exitCode === null, `the bin printed its line: ${out}${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const base = /^AgentRun is running at (http:\/\/127\.0\.0\.1:\d+)\//.exec(out)?.[1];
  assert.ok(base, out);
  const caps = await (await fetch(`${base}/v2/capabilities`)).json();
  assert.equal(caps.models.default, "anthropic/claude-sonnet-5-5", "the server's own default for the key");
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
