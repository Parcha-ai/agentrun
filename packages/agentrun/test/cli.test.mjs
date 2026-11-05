// `npx @parcha/agentrun agents list`: the server's API from the terminal, against a server started with a faux model on
// loopback. The CLI finds the server and its token through DIR/.server.json, prints the response's JSON, exits by what
// happened, and never prints the token.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
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

/** A loopback HTTP server that records every request and answers with `answer(request)`: [status, type, bytes]. */
async function listener(t, answer = () => [200, "application/json", "{}"]) {
  const requests = [];
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(request);
      const [status, type, bytes] = answer(request);
      res.writeHead(status, type ? { "content-type": type } : {}).end(bytes);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  return { base: `http://127.0.0.1:${server.address().port}/v2`, requests };
}

/** The CLI in a child process, without blocking this one (a listener here answers it). */
function run(env, args, { input, extra = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, bytes: Buffer.concat(out), out: Buffer.concat(out).toString("utf8"), err }));
  });
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

  // A home file comes back byte for byte, JSON or not.
  for (const [name, text] of [["odd.json", '{"a":   1,\n "n": 9007199254740993}\n'], ["bad.json", "{not json"]]) {
    writeFileSync(join(dir, name), text);
    const wrote = cli(["home", "write", "demo", `notes/${name}`, "--body", `@${join(dir, name)}`, ...data]);
    assert.equal(wrote.code, 0, wrote.err);
    const read = cli(["home", "read", "demo", `notes/${name}`, ...data]);
    assert.deepEqual([read.code, read.out], [0, text], read.err);
  }

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
  writeFileSync(record, JSON.stringify({ base_url: `http://127.0.0.1:${port}/v2`, pid: gone, token_file: join(dir, ".token") }), { mode: 0o600 });
  writeFileSync(join(dir, ".token"), "ar_local_test_token_0123456789abcdef\n", { mode: 0o600 });
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

  const omitted = join(dir, "omitted.json");
  writeFileSync(omitted, JSON.stringify({ ...resources, omit: { ...resources.omit, noSuchOperation: "gone" } }));
  const goneOmit = check("--resources", omitted);
  assert.equal(goneOmit.status, 1);
  assert.match(goneOmit.stderr, /noSuchOperation/);

  const goneOp = join(dir, "gone.json");
  writeFileSync(goneOp, JSON.stringify({ ...resources, commands: { ...resources.commands, noSuchOperation: ["runs", "nothing"] } }));
  const gone = check("--resources", goneOp);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /noSuchOperation/);
});

test("a .server.json or .token another user could have written is refused, exit 4, and no file the record names is read or sent", async (t) => {
  const { dir, env } = scratch(t);
  const server = await listener(t);
  const data = join(dir, "data");
  mkdirSync(data, { mode: 0o755 });
  chmodSync(data, 0o755);
  const other = join(dir, "other-file");
  writeFileSync(other, "fake-other-file-contents\n");
  const record = join(data, ".server.json");
  writeFileSync(record, JSON.stringify({ base_url: server.base, pid: process.pid, token_file: other }), { mode: 0o644 });
  chmodSync(record, 0o644);
  const planted = await run(env, ["agents", "list", "--data", data]);
  assert.equal(planted.code, 4, planted.err);
  assert.match(planted.err, /\.server\.json/);
  assert.equal(server.requests.length, 0, "nothing was sent");
  assert.ok(!`${planted.out}${planted.err}`.includes("fake-other-file-contents"));

  // The record is the user's own, and names another file: only DIR/.token is read, and here it is open to others.
  chmodSync(record, 0o600);
  writeFileSync(join(data, ".token"), "fake-test-key\n", { mode: 0o644 });
  chmodSync(join(data, ".token"), 0o644);
  const open = await run(env, ["agents", "list", "--data", data]);
  assert.equal(open.code, 4, open.err);
  assert.match(open.err, /\.token/);
  assert.equal(server.requests.length, 0, "nothing was sent");

  chmodSync(join(data, ".token"), 0o600);
  const ok = await run(env, ["agents", "list", "--data", data]);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(server.requests.map((r) => r.headers.authorization), ["Bearer fake-test-key"], "DIR/.token, never the file the record names");
});

test("an API key that is not a valid header value is refused before any request, exit 4, and never printed", async (t) => {
  const { env } = scratch(t);
  const server = await listener(t);
  const key = "fake-test-key\nInjected: x";
  const bad = await run(env, ["agents", "list", "--base-url", server.base], { extra: { AGENTRUN_API_KEY: key } });
  assert.equal(bad.code, 4, bad.err);
  assert.match(bad.err, /not a valid header value/);
  assert.ok(!`${bad.out}${bad.err}`.includes("fake-test-key"), "no output holds the key");
  assert.equal(server.requests.length, 0);
});

test("an inline secret body is refused wherever the path leads once normalized, and a path argument cannot climb out of its route", async (t) => {
  const { env } = scratch(t);
  const server = await listener(t);
  const extra = { AGENTRUN_API_KEY: "fake-test-key" };
  const body = '{"values":{"EXA_API_KEY":"not-a-secret"}}';
  for (const path of ["/other/../settings/tool-keys/exa", "/settings/./tool-keys/exa", "/x/%2e%2e/settings/tool-keys/exa", "/settings//tool-keys/../tool-keys/exa"]) {
    const sent = await run(env, ["api", "PUT", path, "--body", body, "--base-url", server.base], { extra });
    assert.equal(sent.code, 2, `${path}: ${sent.err}`);
  }
  const climbed = await run(env, ["home", "write", "a", "../../../settings/tool-keys/exa", "--body", body, "--base-url", server.base], { extra });
  assert.equal(climbed.code, 2, climbed.err);
  assert.equal(server.requests.length, 0, "nothing was sent");
});

test("header parameters are flags; a required one is checked; a raw body goes as given with --body-type; a JSON body without flags goes byte for byte", async (t) => {
  const { dir, env } = scratch(t);
  const server = await listener(t);
  const extra = { AGENTRUN_API_KEY: "fake-test-key" };
  const at = ["--base-url", server.base];
  assert.equal((await run(env, ["triggers", "fire", "trg_1", ...at], { extra })).code, 2, "Idempotency-Key is required");
  const fired = await run(env, ["triggers", "fire", "trg_1", "--idempotency-key", "k-1", ...at], { extra });
  assert.equal(fired.code, 0, fired.err);
  assert.equal(server.requests.at(-1).headers["idempotency-key"], "k-1");
  const retired = await run(env, ["learning", "retire", "a", "MEMORY.md", "--if-match", '"etag-1"', ...at], { extra });
  assert.equal(retired.code, 0, retired.err);
  assert.equal(server.requests.at(-1).headers["if-match"], '"etag-1"');

  writeFileSync(join(dir, "hello.txt"), "hello, not json\n");
  const plain = await run(env, ["files", "create", "--path", "hello.txt", "--body", `@${join(dir, "hello.txt")}`, "--body-type", "text/plain", ...at], { extra });
  assert.equal(plain.code, 0, plain.err);
  assert.equal(server.requests.at(-1).headers["content-type"], "text/plain");
  assert.equal(server.requests.at(-1).body.toString(), "hello, not json\n");
  assert.equal((await run(env, ["files", "upload", "f_1", "--body", "-", ...at], { extra, input: "raw bytes" })).code, 0);
  assert.equal(server.requests.at(-1).headers["content-type"], "application/octet-stream");
  assert.equal((await run(env, ["agents", "create", "--body", "{}", "--body-type", "text/plain", ...at], { extra })).code, 2, "a type the route does not take");

  const big = '{ "input": {"n": 9007199254740993} }';
  assert.equal((await run(env, ["runs", "start", "a", "--body", big, ...at], { extra })).code, 0);
  assert.equal(server.requests.at(-1).body.toString(), big);
});

test("a download is written as received, and a body that claims JSON but is not is written raw, never thrown on", async (t) => {
  const { env } = scratch(t);
  const files = { "/v2/runs/r1/files/a.json": '{"a":   1,\n "b":9007199254740993}', "/v2/runs/r1/files/b.json": "{not json", "/v2/agents/a": "{not json either" };
  const server = await listener(t, (r) => [200, "application/json", files[r.url]]);
  const extra = { AGENTRUN_API_KEY: "fake-test-key" };
  for (const [args, url] of [[["runs", "read-file", "r1", "a.json"], "/v2/runs/r1/files/a.json"], [["runs", "read-file", "r1", "b.json"], "/v2/runs/r1/files/b.json"], [["agents", "get", "a"], "/v2/agents/a"]]) {
    const got = await run(env, [...args, "--base-url", server.base], { extra });
    assert.equal(got.code, 0, got.err);
    assert.equal(got.bytes.toString(), files[url], args.join(" "));
  }
});

test("learning approve, which takes the owner's console session and refuses every token, is no command", (t) => {
  const { env } = scratch(t);
  const cli = cliOf(env, []);
  assert.equal(cli(["learning", "approve", "--help"]).code, 2);
  assert.doesNotMatch(cli(["learning"]).out, /approve/);
});

test("with no server at the address, the hint names --base-url for a server on another port", async (t) => {
  const { env } = scratch(t);
  const port = await closedPort();
  const down = await run(env, ["agents", "list", "--base-url", `http://127.0.0.1:${port}/v2`], { extra: { AGENTRUN_API_KEY: "fake-test-key" } });
  assert.equal(down.code, 3);
  assert.match(down.err, /--base-url/);
  assert.match(down.err, /ECONNREFUSED/);
});
