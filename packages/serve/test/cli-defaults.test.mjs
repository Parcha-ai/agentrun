// What agentrun-serve picks when it is not told: the first free port from its default (found by listening, so a port
// taken by another process at the same moment is passed over) and, with --open, the browser on the console's address
// where there is one to open. Its default model is the server's (model.ts' hostModel), never one the CLI fixes at start.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as host from "../dist/host.js";
import { startServe } from "../dist/index.js";
import * as model from "../dist/model.js";

// A server here, or one the CLI starts, asks no Docker (on by default when AGENTRUN_BOXES is not set): support.mjs's rule.
process.env.AGENTRUN_BOXES = "none";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FAUX = new URL("./fixtures/faux-model.mjs", import.meta.url).pathname;

// A cleanup never waits on the shared machine without a bound: another process's connection to a held port, or a
// server slow to stop, would otherwise hold the whole file until its timeout.
/** `promise`, or undefined once `ms` pass. */
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
/** A closer for `server`: its open connections ended first, so none can hold the close, which waits at most 5 s. */
function closer(server) {
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  return () => {
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
    return within(new Promise((resolve) => server.close(() => resolve())), 5_000);
  };
}

/** A port held on loopback by this test until it ends. */
async function held(t, port = 0) {
  const server = createServer();
  const close = closer(server);
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  t.after(close);
  return server.address().port;
}

/** The first port from `from` this test can hold: the one a server with no --port would take next. */
async function heldFirstFree(t, from = 7340) {
  for (let port = from; port < from + 100; port++) {
    try {
      return await held(t, port);
    } catch {}
  }
  throw new Error(`no free port from ${from}`);
}
const MODEL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENTRUN_TOKEN", "CI", "DISPLAY", "WAYLAND_DISPLAY"];

test("--open opens a browser unless in CI or on a Linux with no display", () => {
  assert.deepEqual([host.canOpen?.({}, "darwin"), host.canOpen?.({ CI: "1" }, "darwin"), host.canOpen?.({}, "linux"), host.canOpen?.({ DISPLAY: ":0" }, "linux"), host.canOpen?.({ WAYLAND_DISPLAY: "w" }, "freebsd")], [true, false, false, true, true]);
});

/** agentrun-serve started with `args` and no --port, in a fresh home with no model key, on `data` (else a fresh store);
 *  resolves with its base URL once its banner is out. */
async function serve(t, args, env = {}, data = undefined) {
  const home = mkdtempSync(join(tmpdir(), "serve-defaults-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !MODEL_KEYS.includes(name)));
  const child = spawn(process.execPath, [CLI, "--data", data ?? join(home, "agents"), ...args], { env: { ...clean, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => stopChild(child, exited));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !/^Open /m.test(out); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server printed its banner: ${out}${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stop = () => stopChild(child, exited);
  return { home, base: /AGENTRUN_BASE_URL=(\S+)\/v2/.exec(out)[1], out, stop };
}

test("with accounts off (AGENTRUN_ACCOUNTS=0), the AGENTRUN_PUBLIC_URL name is served on loopback as with them on, and another name is still refused", { timeout: 120_000 }, async (t) => {
  // Port 0: the server's own listen picks the port, so no other process can take it between a pick and the listen. The
  // banner's first line names the local address; AGENTRUN_BASE_URL names the public one.
  const { out } = await serve(t, ["--port", "0"], { AGENTRUN_ACCOUNTS: "0", AGENTRUN_PUBLIC_URL: "https://agentrun.example.com" });
  assert.match(out, /^Open https:\/\/agentrun\.example\.com\//m, out);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)?.[1]);
  assert.ok(port > 0, `the banner names the local port: ${out}`);
  const { request } = await import("node:http");
  const status = (name) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/v2/capabilities", headers: { host: name } }, (res) => (res.resume(), resolve(res.statusCode)));
      req.once("error", reject).end();
    });
  assert.equal(await status("agentrun.example.com"), 200, "the public name, as a proxy in front sends it");
  assert.equal(await status(`localhost:${port + 1}`), 200);
  assert.equal(await status("evil.example"), 403);
});

test("demo: with no --port the server takes the first free port from its default", { timeout: 120_000 }, async (t) => {
  const busy = await heldFirstFree(t);
  const { base } = await serve(t, []);
  const port = Number(new URL(base).port);
  assert.ok(port > busy, `${port} passes over ${busy}, which is in use`);
});

// The default model is the server's reading of its keys (model.ts' hostModel), never fixed at its start: a key saved in
// the console after a start on another provider's key moves it to the first of MODEL_KEYS with a key.
test("demo: started on an OpenAI key alone, pi's default model follows an Anthropic key saved in the console, with no restart", { timeout: 120_000 }, async (t) => {
  // The Anthropic key's check (key-check.ts) answered on loopback: no network.
  const provider = createHttpServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}'));
  const closeProvider = closer(provider);
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(closeProvider);
  const token = randomBytes(24).toString("hex");
  const env = { OPENAI_API_KEY: "not-a-secret", AGENTRUN_TOKEN: token, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}` };
  const { base } = await serve(t, ["--port", "0"], env);
  const api = (method, path, body) => fetch(`${base}/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const piDefault = async () => (await (await api("GET", "/capabilities")).json()).harnesses.find((harness) => harness.id === "pi").default_model;
  const firstKeyed = (keys) => model.MODEL_KEYS.find((row) => keys.includes(row.field)).model;
  assert.equal(await piDefault(), firstKeyed(["OPENAI_API_KEY"]));
  assert.equal((await api("PUT", "/settings/tool-keys/anthropic", { values: { ANTHROPIC_API_KEY: "not-a-secret" } })).status, 204);
  assert.equal(await piDefault(), firstKeyed(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]), "the saved key moves the default, with no restart");
});

test("demo: --open opens the console's address in the browser where there is a display, and never in CI; never a link with the token, even the one the banner prints", { timeout: 180_000 }, async (t) => {
  const fake = mkdtempSync(join(tmpdir(), "serve-open-"));
  t.after(() => rmSync(fake, { recursive: true, force: true }));
  const opened = join(fake, "opened");
  for (const name of ["xdg-open", "open"]) {
    writeFileSync(join(fake, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);
    chmodSync(join(fake, name), 0o755);
  }
  const path = `${fake}:${process.env.PATH}`;
  // The opener's whole line: the stub's `>>` makes the file before its printf writes, so the file existing is not enough.
  const handedLine = async () => {
    for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) {
      const text = existsSync(opened) ? readFileSync(opened, "utf8") : "";
      if (text.endsWith("\n")) return text;
    }
    return existsSync(opened) ? readFileSync(opened, "utf8") : "";
  };
  const { base } = await serve(t, ["--port", "0", "--open"], { PATH: path, DISPLAY: ":0" });
  assert.equal(await handedLine(), `${base}/\n`);
  rmSync(opened);
  // Accounts off, on a fresh store: the banner prints its sign-in link, but the opener's arguments (any process's to read)
  // and the browser's history get the page alone.
  const store = join(fake, "store");
  const made = await serve(t, ["--port", "0", "--open"], { PATH: path, DISPLAY: ":0", AGENTRUN_ACCOUNTS: "0" }, store);
  const handed = await handedLine();
  assert.match(/^Open (\S+)/m.exec(made.out)?.[1] ?? "", /^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w%.-]+$/, made.out);
  assert.doesNotMatch(handed, /token=/, "no token in the opener's arguments");
  assert.equal(handed, `${made.base}/\n`);
  rmSync(opened);
  await made.stop();
  // The same store started again: the token is not printed, so the browser gets the plain address, never a placeholder.
  const kept = await serve(t, ["--port", "0", "--open"], { PATH: path, DISPLAY: ":0", AGENTRUN_ACCOUNTS: "0" }, store);
  assert.equal(await handedLine(), `${kept.base}/\n`);
  rmSync(opened);
  await serve(t, ["--port", "0", "--open"], { PATH: path, DISPLAY: ":0", CI: "1" });
  await serve(t, ["--port", "0"], { PATH: path, DISPLAY: ":0" });
  assert.equal(existsSync(opened), false, "not in CI, and not without --open");
});

// The port is found by listening on it: a port another process takes after any look at it, and before this server
// listens, is passed over to the next. Only a port the server was not given moves.
test("a server free to pick its port listens on the next one when its port is taken at the listen; one given its port fails at once, naming it", { timeout: 60_000 }, async (t) => {
  const taken = await held(t);
  const dir = mkdtempSync(join(tmpdir(), "serve-port-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moved = await startServe({ data: join(dir, "a"), port: taken, nextFreePort: true, faux: FAUX });
  t.after(() => within(moved.close(), 10_000));
  assert.ok(moved.port > taken && moved.port < taken + 100, `${moved.port} is past ${taken}, which is taken`);
  assert.equal(moved.url, `http://127.0.0.1:${moved.port}`);
  assert.equal((await fetch(`${moved.baseUrl}/health`)).status, 200);
  await assert.rejects(startServe({ data: join(dir, "b"), port: taken, faux: FAUX }), (error) => error.code === "EADDRINUSE" && error.message.includes(`127.0.0.1:${taken}`));
});

// Each taken port is one attempt on the same server: an attempt that failed leaves none of its handlers on it, so
// passing over many taken ports adds no listener per port.
test("a server free to pick its port passes over 11 taken ports with no listener left behind per attempt", { timeout: 60_000 }, async (t) => {
  const listen = (port) => new Promise((resolve) => { const server = createServer(); const close = closer(server); server.once("error", () => resolve(undefined)).listen(port, "127.0.0.1", () => resolve(close)); });
  const close = (closeIt) => closeIt();
  // 11 consecutive ports this test holds from a base, and the one after them free.
  let base;
  for (let tries = 0; base === undefined && tries < 50; tries++) {
    const from = 20_000 + Math.floor(Math.random() * 40_000);
    const servers = [];
    for (let port = from; port < from + 11; port++) {
      const server = await listen(port);
      if (!server) break;
      servers.push(server);
    }
    const next = servers.length === 11 ? await listen(from + 11) : undefined;
    if (next) {
      await close(next);
      base = from;
      t.after(() => Promise.all(servers.map(close)));
    } else await Promise.all(servers.map(close));
  }
  assert.ok(base !== undefined, "found 11 free consecutive ports and the one after them");
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  const dir = mkdtempSync(join(tmpdir(), "serve-ports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moved = await startServe({ data: join(dir, "a"), port: base, nextFreePort: true, faux: FAUX });
  t.after(() => within(moved.close(), 10_000));
  // A warning is emitted on the next tick: one turn of the event loop lets any reach the handler.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(moved.port, base + 11, `${moved.port} is the first free port from ${base}`);
  assert.deepEqual(warnings.filter((warning) => warning.name === "MaxListenersExceededWarning").map((warning) => warning.message), []);
});

test("demo: two servers started at once with no --port each take a port of their own, and --port on a taken port fails at once, naming it", { timeout: 120_000 }, async (t) => {
  const [one, two] = await Promise.all([serve(t, []), serve(t, [])]);
  assert.notEqual(one.base, two.base);
  for (const { base } of [one, two]) assert.equal((await fetch(`${base}/v2/health`)).status, 200, base);
  const taken = await held(t);
  const home = mkdtempSync(join(tmpdir(), "serve-taken-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [CLI, "--data", join(home, "agents"), "--port", String(taken)], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => stopChild(child, exited));
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  assert.equal(await exited, 1, err);
  assert.match(err, new RegExp(`EADDRINUSE.*127\\.0\\.0\\.1:${taken}`));
});
