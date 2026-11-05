// `npx @parcha/agentrun agents list`: the server's API from the terminal, against a server started with a faux model on
// loopback. The CLI finds the server and its token through DIR/.server.json, prints the response's JSON, exits by what
// happened, and never prints the token.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
const GENERATOR = join(ROOT, "scripts", "generate-clients.mjs");
const TABLE = join(ROOT, "packages", "agentrun", "lib", "commands.generated.mjs");
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name)));
  return { dir, env: { ...env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") } };
}

/** A port nothing listens on. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** The server on `data`, with a faux model; resolves once it wrote DIR/.server.json. */
async function serve(t, dir, env) {
  const faux = join(dir, "faux.mjs");
  writeFileSync(faux, 'export default (context, faux) => faux.message("The answer is 42.");\n');
  const data = join(dir, "data");
  const child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", faux], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0" } });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !existsSync(join(data, ".server.json")); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, exited, data, token: readFileSync(join(data, ".token"), "utf8").trim() };
}

function cliOf(env, seen) {
  return (args, { input, extra = {} } = {}) => {
    const run = spawnSync(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, input, encoding: "utf8", timeout: 60_000 });
    seen.push(run.stdout, run.stderr);
    return { code: run.status, out: run.stdout, err: run.stderr, json: () => JSON.parse(run.stdout) };
  };
}

test("demo: the CLI creates an agent, starts a capped run, reads it, lists runs and sends it a message, the token never in its output", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch(t);
  const server = await serve(t, dir, env);
  const record = join(server.data, ".server.json");
  assert.equal(statSync(record).mode & 0o777, 0o600);
  assert.equal(statSync(server.data).mode & 0o777, 0o700);
  const written = JSON.parse(readFileSync(record, "utf8"));
  assert.deepEqual(Object.keys(written).sort(), ["base_url", "pid", "token_file"]);
  assert.equal(written.pid, server.child.pid);
  assert.equal(written.token_file, join(server.data, ".token"));
  assert.match(written.base_url, /^http:\/\/127\.0\.0\.1:\d+\/v2$/);

  const seen = [readFileSync(record, "utf8")];
  const cli = cliOf(env, seen);
  const data = ["--data", server.data];
  writeFileSync(join(dir, "agent.json"), JSON.stringify({ definition: { id: "demo", version: 1, name: "demo", instructions: "Answer.", skills: [], tools: [] } }));

  const created = cli(["--data", server.data, "agents", "create", "--body", `@${join(dir, "agent.json")}`]);
  assert.equal(created.code, 0, created.err);
  assert.equal(created.json().agent_id, "demo");
  assert.equal(created.out.trim().split("\n").length, 1, "one line when piped");

  const listed = cli(["agents", "list", ...data]);
  assert.equal(listed.code, 0, listed.err);
  assert.deepEqual(listed.json().agents.map((a) => a.agent_id), ["demo"]);

  const started = cli(["runs", "start", "demo", "--max-cost-usd", "2", "--body", '{"input":{"content":"What is the answer?"},"max_cost_usd":9}', ...data]);
  assert.equal(started.code, 0, started.err);
  const run = started.json();
  assert.equal(run.cost.cap_usd, 2, "the flag wins over the body's field");

  let got;
  for (let i = 0; ; i++) {
    got = cli(["runs", "get", run.run_id, ...data]);
    assert.equal(got.code, 0, got.err);
    if (got.json().status === "completed") break;
    assert.ok(i < 100, `the run completed: ${got.out}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(got.json().run_id, run.run_id);

  const runs = cli(["runs", "list", "--agent", "demo", "--limit", "5", ...data]);
  assert.equal(runs.code, 0, runs.err);
  assert.deepEqual(runs.json().runs.map((r) => r.run_id), [run.run_id]);

  const message = cli(["runs", "message", run.run_id, "--content", "And again?", ...data]);
  assert.equal(message.code, 0, message.err);
  assert.equal(message.json().run_id, run.run_id);

  const raw = cli(["api", "GET", "/health", ...data]);
  assert.deepEqual([raw.code, raw.json().status], [0, "ok"]);
  const deleted = cli(["webhook", "delete", ...data]);
  assert.deepEqual([deleted.code, deleted.out], [0, ""], deleted.err);

  // 1: the server refused, its error JSON on stderr.
  const missing = cli(["runs", "get", "no-such-run", ...data]);
  assert.deepEqual([missing.code, missing.out, JSON.parse(missing.err).error.code], [1, "", "not_found"]);
  // 2: bad usage, nothing sent.
  for (const args of [["runs", "get"], ["runs", "start", "demo", "--max-cost-usd", "two"], ["runs", "bogus"], ["agents", "list", "--no-such-flag"], ["runs", "start", "demo", "--body", "{not json"]]) {
    assert.equal(cli([...args, ...data]).code, 2, args.join(" "));
  }
  // A body that carries a secret is never taken from the command line.
  const inline = cli(["tool-keys", "save", "exa", "--body", '{"values":{"EXA_API_KEY":"not-a-secret"}}', ...data]);
  assert.equal(inline.code, 2);
  assert.match(inline.err, /--body -/);
  const rawInline = cli(["api", "PUT", "/settings/tool-keys/exa", "--body", '{"values":{"EXA_API_KEY":"not-a-secret"}}', ...data]);
  assert.equal(rawInline.code, 2);
  for (const run of [inline, rawInline]) assert.ok(!`${run.out}${run.err}`.includes("not-a-secret"), "the refused value is in no output");
  // 3: nothing answers.
  const port = await closedPort();
  const unreachable = cli(["agents", "list", "--base-url", `http://127.0.0.1:${port}/v2`], { extra: { AGENTRUN_API_KEY: "fake-test-key" } });
  assert.equal(unreachable.code, 3);
  assert.match(unreachable.err, /Cannot reach the server/);
  // 4: no token for a server named by URL, and a token the server refuses.
  const noToken = cli(["agents", "list", "--base-url", written.base_url]);
  assert.equal(noToken.code, 4);
  assert.match(noToken.err, /AGENTRUN_API_KEY/);
  const wrong = cli(["agents", "list", ...data], { extra: { AGENTRUN_API_KEY: "fake-test-key" } });
  assert.notEqual(server.token, "fake-test-key");
  assert.equal(wrong.code, 4);
  // The local server's token is never sent to another address.
  const elsewhere = cli(["agents", "list", "--base-url", `http://127.0.0.1:${port}/v2`, ...data]);
  assert.equal(elsewhere.code, 4);

  for (const text of seen) assert.ok(!text.includes(server.token), "no output holds the token");
  server.child.kill("SIGTERM");
  assert.equal(await server.exited, 0);
  assert.equal(existsSync(record), false, "a clean exit removes DIR/.server.json");
});

test("a stale DIR/.server.json is said plainly, exit 3; a server started with its token in the environment needs AGENTRUN_API_KEY, exit 4", async (t) => {
  const { dir, env } = scratch(t);
  const cli = cliOf(env, []);
  const record = join(dir, ".server.json");
  const port = await closedPort();
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(record, JSON.stringify({ base_url: `http://127.0.0.1:${port}/v2`, pid: gone, token_file: join(dir, ".token") }));
  writeFileSync(join(dir, ".token"), "ar_local_test_token_0123456789abcdef\n");
  const dead = cli(["agents", "list", "--data", dir]);
  assert.equal(dead.code, 3);
  assert.equal(dead.err, `The server recorded in ${record} (pid ${gone}) is not running; start it with \`npx @parcha/agentrun\` or set AGENTRUN_BASE_URL.\n`);
  // A pid that is alive (another process took it) but no server at the address: the same.
  writeFileSync(record, JSON.stringify({ base_url: `http://127.0.0.1:${port}/v2`, pid: process.pid, token_file: join(dir, ".token") }));
  const silent = cli(["agents", "list", "--data", dir]);
  assert.equal(silent.code, 3);
  assert.match(silent.err, /is not running/);
  writeFileSync(record, JSON.stringify({ base_url: `http://127.0.0.1:${port}/v2`, pid: process.pid }));
  const envToken = cli(["agents", "list", "--data", dir]);
  assert.equal(envToken.code, 4);
  assert.match(envToken.err, /set AGENTRUN_API_KEY/);
  for (const run of [dead, silent, envToken]) assert.ok(!run.err.includes("ar_local_test_token"));
});

test("help: agentrun help lists the commands, a noun lists its verbs, a command's --help its arguments; --help alone is the launcher's", (t) => {
  const { env } = scratch(t);
  const cli = cliOf(env, []);
  const help = cli(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /^ {2}runs +.*\bstart\b/m);
  assert.match(cli(["runs"]).out, /agentrun runs start AGENT_ID/);
  const start = cli(["runs", "start", "--help"]);
  assert.equal(start.code, 0);
  assert.match(start.out, /--max-cost-usd NUMBER/);
  assert.match(cli(["--help"]).out, /^Usage: npx @parcha\/agentrun \[--port N\]/);
});

test("generate-clients --check passes on the committed table, and fails on a hand-edited table, a duplicate command or an operation gone", { timeout: 60_000 }, (t) => {
  const { dir } = scratch(t);
  const check = (...args) => spawnSync(process.execPath, [GENERATOR, "--check", ...args], { encoding: "utf8", cwd: ROOT });
  const committed = check();
  assert.equal(committed.status, 0, committed.stderr);

  const edited = join(dir, "edited.mjs");
  writeFileSync(edited, readFileSync(TABLE, "utf8").replace('"summary": "Start a run"', '"summary": "Start a run now"'));
  const stale = check("--out", edited);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /run node scripts\/generate-clients\.mjs/);

  const resources = JSON.parse(readFileSync(join(ROOT, "scripts", "clients", "resources.json"), "utf8"));
  const twice = join(dir, "twice.json");
  writeFileSync(twice, JSON.stringify({ ...resources, commands: { ...resources.commands, getRun: ["runs", "start"] } }));
  const duplicate = check("--resources", twice);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /getRun and createRun are both "runs start"|createRun and getRun are both "runs start"/);

  const goneOp = join(dir, "gone.json");
  writeFileSync(goneOp, JSON.stringify({ ...resources, commands: { ...resources.commands, noSuchOperation: ["runs", "nothing"] } }));
  const gone = check("--resources", goneOp);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /noSuchOperation/);
});
