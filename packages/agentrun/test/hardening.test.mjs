// The CLI's edges, each against a loopback listener of its own: a body refused for a path that ends like a secret route
// says why; runs start --wait bounds its start; a stream event that is not JSON is the server's bad answer, not an
// unreachable one; a refused server record is exit 4; login's config write fails plainly; an api header keeps any name.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-hardening-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name)));
  return { dir, env: { ...env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), AGENTRUN_API_KEY: "fake-test-key" } };
}

/** A loopback listener under its own random path prefix (part of `base`), recording each request under it and
 *  answering with `answer(request, res)`, which may answer itself (or never); anything else is a bare 404. */
async function listener(t, answer) {
  const requests = [];
  const prefix = `/${randomBytes(8).toString("hex")}`;
  const server = createServer((req, res) => {
    if (!req.url.startsWith(`${prefix}/`)) return void req.resume().on("end", () => res.writeHead(404).end());
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method, url: req.url.slice(prefix.length), headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) };
      requests.push(request);
      answer(request, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  return { base: `http://127.0.0.1:${server.address().port}${prefix}/v2`, requests };
}

/** The CLI in a child process, killed after `timeout` ms (its code then null). */
const cli = (env, args, { input = "", timeout = 20_000 } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.once("close", (code) => (clearTimeout(timer), resolve({ code, out, err })));
  child.stdin.end(input);
});

test("a body for a path that ends like a secret route is refused inline, and the refusal says why", async (t) => {
  const { env } = scratch(t);
  const server = await listener(t, (request, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  const refused = await cli(env, ["home", "write", "demo", "settings/tool-keys/x", "--body", "hello", "--body-type", "text/plain", "--base-url", server.base]);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /ends like the secret route PUT \/settings\/tool-keys\/\{key_id\}/);
  assert.match(refused.err, /--body -.*--body @FILE/);
  assert.equal(server.requests.length, 0, "nothing sent");
  const piped = await cli(env, ["home", "write", "demo", "settings/tool-keys/x", "--body", "-", "--body-type", "text/plain", "--base-url", server.base], { input: "hello" });
  assert.equal(piped.code, 0, piped.err);
  assert.deepEqual([server.requests[0].method, server.requests[0].url, server.requests[0].body.toString()], ["PUT", ["", "v2", "agents", "demo", "home", "files", "settings", "tool-keys", "x"].join("/"), "hello"]);
});

test("runs start --wait --timeout bounds the start too: a server that never answers it is given up on in time, exit 1", async (t) => {
  const { env } = scratch(t);
  // Takes the start and never answers it.
  const server = await listener(t, () => {});
  const began = Date.now();
  const started = await cli(env, ["runs", "start", "demo", "--body", '{"input":{"content":"hi"}}', "--wait", "--timeout", "1", "--base-url", server.base], { timeout: 15_000 });
  assert.equal(started.code, 1, `${started.code} ${started.err}`);
  assert.ok(Date.now() - began < 10_000, "given up on near its timeout");
  assert.match(started.err, /did not answer the start within 1 s; it may have started the run: look for it with `agentrun runs list --agent demo`/);
  assert.equal(started.out, "");
  assert.equal(server.requests.length, 1);
});

test("runs timeline --follow: a stream event that is not a JSON object is the server's bad answer, exit 1, never exit 3", { timeout: 60_000 }, async (t) => {
  const { env } = scratch(t);
  for (const event of ["event: rows\ndata: {not json\n\n", "event: rows\ndata: null\n\n", "event: rows\ndata: []\n\n", "event: end\ndata: terminal?\n\n", "event: end\ndata: []\n\n"]) {
    const server = await listener(t, (request, res) => res.writeHead(200, { "content-type": "text/event-stream" }).end(event));
    const followed = await cli(env, ["runs", "timeline", "r1", "--follow", "--base-url", server.base], { timeout: 40_000 });
    assert.equal(followed.code, 1, `${JSON.stringify(event)}: ${followed.code} ${followed.err}`);
    assert.match(followed.err, /^The server's timeline stream sent an? (?:rows|end) event that is not a JSON object\.\n$/);
    assert.doesNotMatch(followed.err, /Cannot reach/);
    assert.equal(server.requests.length, 1, "not tried again");
  }
});

test("a server record whose base_url is not a base URL is refused as a malformed record is, exit 4; a bad --base-url is usage, exit 2", async (t) => {
  const { dir, env } = scratch(t);
  const data = join(dir, "data");
  mkdirSync(data, { mode: 0o700 });
  for (const base_url of ["ftp://127.0.0.1/v2", "http://127.0.0.1:9/v2#x", 7]) {
    writeFileSync(join(data, ".server.json"), JSON.stringify({ base_url, pid: process.pid, token_file: join(data, ".token") }), { mode: 0o600 });
    const refused = await cli(env, ["agents", "list", "--data", data]);
    assert.equal(refused.code, 4, `${base_url}: ${refused.err}`);
    assert.match(refused.err, /\.server\.json is not a server record/);
  }
  writeFileSync(join(data, ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:9/v2", pid: process.pid, token_file: join(data, ".token") }), { mode: 0o600 });
  const usage = await cli(env, ["agents", "list", "--data", data, "--base-url", "ftp://127.0.0.1/v2"]);
  assert.equal(usage.code, 2, usage.err);
});

test("login: a config file it cannot write is said plainly, exit 4, with nothing left behind", async (t) => {
  const { dir, env } = scratch(t);
  const server = await listener(t, (request, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"agents":[],"next_cursor":null}'));
  const config = join(dir, ".config", "agentrun");
  // Where its folder goes, a file; then, where the file goes, a folder.
  mkdirSync(join(dir, ".config"));
  writeFileSync(config, "not a folder\n");
  const blocked = await cli(env, ["login", "--base-url", server.base], { input: "fake-test-key\n" });
  assert.equal(blocked.code, 4, blocked.err);
  assert.match(blocked.err, /^Cannot write the config file .*config\.json \(E[A-Z]+\); nothing was written\.\n$/);
  rmSync(config);
  mkdirSync(join(config, "config.json"), { recursive: true });
  const taken = await cli(env, ["login", "--base-url", server.base], { input: "fake-test-key\n" });
  assert.equal(taken.code, 4, taken.err);
  assert.match(taken.err, /^Cannot write the config file .*config\.json \(E[A-Z]+\); nothing was written\.\n$/);
  assert.deepEqual(readdirSync(config), ["config.json"], "no temporary file left");
  for (const ran of [blocked, taken]) assert.ok(!ran.err.includes("fake-test-key") && !ran.out.includes("fake-test-key"));
});

test("api --header keeps a header of any name it can send, constructor among them, and refuses __proto__, which fetch would drop", async (t) => {
  const { env } = scratch(t);
  const server = await listener(t, (request, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  // In any case and with any space around it: header names are matched in lower case, as they are sent.
  for (const header of ["__proto__: one", "__PROTO__: one", " __Proto__ : one"]) {
    const refused = await cli(env, ["api", "GET", "/health", "--header", header, "--base-url", server.base]);
    assert.equal(refused.code, 2, `${header}: ${refused.err}`);
    assert.match(refused.err, /--header cannot send a header named __proto__/);
  }
  assert.equal(server.requests.length, 0, "nothing sent");
  const sent = await cli(env, ["api", "GET", "/health", "--header", "constructor: two", "--header", "x-plain: three", "--base-url", server.base]);
  assert.equal(sent.code, 0, sent.err);
  const raw = server.requests[0].rawHeaders;
  const got = raw.filter((_, i) => i % 2 === 0).map((name, i) => [name.toLowerCase(), raw[2 * i + 1]]).filter(([name]) => ["constructor", "x-plain"].includes(name));
  assert.deepEqual(got.sort(), [["constructor", "two"], ["x-plain", "three"]], JSON.stringify(raw));
});

test("an Accept given with api --header is the one sent, in any case; without one the default goes; a download still reads its bytes", async (t) => {
  const { env } = scratch(t);
  const server = await listener(t, (request, res) => (request.url.includes("/files/") ? res.writeHead(200, { "content-type": "text/plain" }).end("the bytes\n") : res.writeHead(200, { "content-type": "application/json" }).end("{}")));
  const accepted = async (...header) => {
    const sent = await cli(env, ["api", "GET", "/runs/r1/timeline", ...header, "--base-url", server.base]);
    assert.equal(sent.code, 0, sent.err);
    const raw = server.requests.at(-1).rawHeaders;
    return raw.filter((_, i) => i % 2 === 0).map((name, i) => [name.toLowerCase(), raw[2 * i + 1]]).filter(([name]) => name === "accept").map(([, value]) => value);
  };
  assert.deepEqual(await accepted("--header", "Accept: text/event-stream"), ["text/event-stream"]);
  assert.deepEqual(await accepted("--header", "accept: x/y"), ["x/y"]);
  assert.deepEqual(await accepted(), ["application/json, */*"]);
  const read = await cli(env, ["runs", "read-file", "r1", "notes.md", "--base-url", server.base]);
  assert.deepEqual([read.code, read.out], [0, "the bytes\n"], read.err);
  assert.equal(server.requests.at(-1).headers.authorization, "Bearer fake-test-key", "the token goes last, as set");
});

/** The CLI in this process (`main`), its stdin `input` and its output kept: for a test that replaces an fs function. */
async function inProcess(args, env, input = "") {
  const { main } = await import("../lib/cli.mjs");
  const { Readable } = await import("node:stream");
  let out = "";
  let err = "";
  const io = { stdin: Readable.from([Buffer.from(input)]), stdout: { isTTY: false, write: (c) => ((out += c), true), on() {} }, stderr: { isTTY: false, write: (c) => ((err += c), true) } };
  const code = await main(args, env, io);
  return { code, out, err };
}

test("login writes the whole config or none of it: a short write is written on, a failed one leaves the old config as it was", async (t) => {
  const { dir, env } = scratch(t);
  const server = await listener(t, (request, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"agents":[],"next_cursor":null}'));
  const config = join(dir, ".config", "agentrun", "config.json");
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const real = fs.writeSync;
  /** fs.writeSync replaced, for the files login writes (not stdout or stderr), by one that writes at most 7 bytes a call,
   *  and throws ENOSPC once `budget` calls are spent. */
  const stub = (budget = Infinity) => {
    let calls = 0;
    fs.writeSync = (fd, data, ...rest) => {
      if (fd <= 2) return real(fd, data, ...rest);
      if (++calls > budget) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const offset = typeof data === "string" ? 0 : (rest[0] ?? 0);
      const length = typeof data === "string" ? bytes.length : (rest[1] ?? bytes.length - offset);
      return real(fd, bytes, offset, Math.min(length, 7));
    };
    syncBuiltinESMExports();
  };
  t.after(() => ((fs.writeSync = real), syncBuiltinESMExports()));

  stub();
  const short = await inProcess(["login", "--base-url", server.base], env, "fake-test-key\n");
  assert.equal(short.code, 0, short.err);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { base_url: server.base, api_key: "fake-test-key" }, "written whole, 7 bytes at a time");

  const before = readFileSync(config);
  stub(2);
  const full = await inProcess(["login", "--base-url", server.base], env, "fake-test-key-two\n");
  assert.equal(full.code, 4, full.err);
  assert.match(full.err, /Cannot write the config file .*\(ENOSPC\); nothing was written\./);
  assert.deepEqual(readFileSync(config), before, "the old config is as it was");
  assert.deepEqual(readdirSync(join(dir, ".config", "agentrun")), ["config.json"], "no temporary file left");
});
