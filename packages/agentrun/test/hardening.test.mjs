// The CLI's edges, each against a loopback listener of its own: a body refused for a path that ends like a secret route
// says why; runs start --wait bounds its start; a stream event that is not JSON is the server's bad answer, not an
// unreachable one; a refused server record is exit 4; login's config write fails plainly; an api header keeps any name.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  assert.deepEqual([server.requests[0].method, server.requests[0].url, server.requests[0].body.toString()], ["PUT", "/v2/agents/demo/home/files/settings/tool-keys/x", "hello"]);
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
