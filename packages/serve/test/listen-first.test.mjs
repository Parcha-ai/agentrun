// The address first: agentrun-serve's CLI binds its port and prints "Starting <url>/" before the bulk of the server loads,
// which on a slow disk is most of a start. Until the server is ready it answers that it is warming: GET /v2/health says
// so (503), the API answers 503 unavailable with a Retry-After, and a browser gets a page that reloads itself. Then the
// server takes the same socket over, and its banner ("Open ") says it is ready, as before.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openapiDocument } from "../dist/openapi.js";
import { printed } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FAUX = new URL("./fixtures/faux-model.mjs", import.meta.url).pathname;
const HOLD = new URL("./fixtures/hold-server-load.mjs", import.meta.url).pathname;
const MODEL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENTRUN_TOKEN", "AGENTRUN_TOKENS", "CI", "DISPLAY", "WAYLAND_DISPLAY"];

/** `promise`, or undefined once `ms` pass. */
const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};

/** agentrun-serve's CLI, started with `args` in a fresh home (on `data`, else a store in that home), its load of
 *  dist/server.js held until `release` exists. */
function cli(t, args, { release = "", data } = {}) {
  const home = mkdtempSync(join(tmpdir(), "serve-listen-first-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !MODEL_KEYS.includes(name)));
  const child = spawn(process.execPath, ["--import", HOLD, CLI, "--data", data ?? join(home, "agents"), "--faux", FAUX, ...args], {
    env: { ...clean, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), AGENTRUN_BOXES: "none", AGENTRUN_LOG: "quiet", AGENTRUN_TEST_RELEASE: release },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      if ((await within(exited, 15_000)) === undefined) child.kill("SIGKILL");
      await within(exited, 5_000);
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { child, exited, home, out: () => out, err: () => err };
}

test("the CLI binds and prints Starting <url>/ before the server loads; once it has loaded, its banner names the same port", { timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "serve-listen-first-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = join(dir, "release");
  const server = cli(t, ["--port", "0"], { release });
  const starting = await printed(server.child, /^Starting http:\/\/127\.0\.0\.1:\d+\/ /m);
  const url = /^Starting (http:\/\/127\.0\.0\.1:\d+)\/ /m.exec(starting)[1];
  // The server's load is still held (its hooks hold the CLI's thread too, so nothing is asked of it here): no banner.
  assert.doesNotMatch(server.out(), /^(Open |AGENTRUN_BASE_URL=)/m, server.out());
  writeFileSync(release, "");
  await printed(server.child, /^Open /m);
  assert.equal(/^AGENTRUN_BASE_URL=(\S+)\/v2$/m.exec(server.out())?.[1], url, server.out());
  assert.ok(server.out().indexOf("Starting ") < server.out().indexOf("Open "), "Starting comes first");
});

test("until the server is ready, it answers warming: health says so, the API answers 503 unavailable and a browser gets a page that reloads; then the same port serves", { timeout: 240_000 }, async (t) => {
  // A second server on a data directory another holds waits for it (a restart that starts the new one first), listening:
  // the warming answers, for as long as the first holds the store.
  const dir = mkdtempSync(join(tmpdir(), "serve-listen-first-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  const first = cli(t, ["--port", "0"], { data });
  await printed(first.child, /^Open /m);
  const server = cli(t, ["--port", "0"], { data });
  const starting = await printed(server.child, /^Starting http:\/\/127\.0\.0\.1:\d+\/ /m);
  const url = /^Starting (http:\/\/127\.0\.0\.1:\d+)\/ /m.exec(starting)[1];
  assert.doesNotMatch(server.out(), /^(Open |AGENTRUN_BASE_URL=)/m, server.out());

  const health = await fetch(`${url}/v2/health`);
  assert.equal(health.status, 503);
  assert.equal(health.headers.get("retry-after"), "2");
  const warmBody = await health.json();
  assert.equal(warmBody.status, "warming");
  assert.equal(warmBody.checks.store, "opening");
  assert.ok(["ok", "below_floor", "cannot_check"].includes(warmBody.checks.disk), JSON.stringify(warmBody));

  const api = await fetch(`${url}/v2/agents`, { headers: { authorization: "Bearer not-a-key" } });
  assert.equal(api.status, 503);
  assert.equal(api.headers.get("retry-after"), "2");
  assert.ok(/^req_[0-9a-f]{16}$/.test(api.headers.get("x-request-id") ?? ""), "a request id, as every answer has");
  const refused = await api.json();
  assert.equal(refused.error.code, "unavailable");
  assert.equal(refused.error.retryable, true);
  assert.match(refused.error.message, /starting/);

  const page = await fetch(`${url}/`, { headers: { accept: "text/html" } });
  assert.equal(page.status, 503);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  const html = await page.text();
  assert.match(html, /<meta http-equiv="refresh" content="2">/);
  assert.match(html, /AgentRun is starting/);

  // The first server stops: this one takes the store and the socket over, and prints its banner on the same port.
  first.child.kill("SIGTERM");
  await first.exited;
  const banner = await printed(server.child, /^Open /m);
  assert.equal(/^AGENTRUN_BASE_URL=(\S+)\/v2$/m.exec(server.out())?.[1], url, banner);
  const ready = await fetch(`${url}/v2/health`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, "ok");
  assert.ok(server.out().indexOf("Starting ") < server.out().indexOf("Open "), "Starting comes first");
});

test("a port already taken is left to the start's own wait, as before: no Starting line, and the start says the port is in use", { timeout: 120_000 }, async (t) => {
  // The port's holder cuts off whatever connects to it, so its close at the end waits on no visitor's connection.
  const taken = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => taken.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => taken.close(() => resolve())));
  // A visitor that asks the port GET / and stays, as a box's port watcher does to every new listener.
  const visitor = connect(taken.address().port, "127.0.0.1", () => visitor.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
  visitor.on("error", () => {});
  const server = cli(t, ["--port", String(taken.address().port)]);
  const { code } = await server.exited;
  assert.equal(code, 1, server.out() + server.err());
  assert.doesNotMatch(server.out(), /^Starting /m, "the early bind gave the port up to the start's own listen");
  assert.match(server.err(), /EADDRINUSE/, server.err());
});

test("GET /v2/health's spec takes the warming answer: status warming, the store opening", () => {
  const doc = openapiDocument(() => undefined);
  const path = Object.keys(doc.paths).find((p) => /(^|\/)health$/.test(p));
  const schema = doc.paths[path].get.responses["503"].content["application/json"].schema;
  assert.ok(schema.properties.status.enum.includes("warming"), JSON.stringify(schema));
  assert.ok(schema.properties.checks.properties.store.enum.includes("opening"), JSON.stringify(schema));
});

test("a server on every address is reached from another machine at this machine's IPv4 addresses: not loopback, link-local, IPv6 or a container bridge, not in a container, not on one address", async () => {
  const { elsewhereOf } = await import("../dist/listen-first.js");
  const interfaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "192.0.2.10", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
    en1: [{ address: "169.254.3.4", family: "IPv4", internal: false }, { address: "198.51.100.7", family: "IPv4", internal: false }],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    "br-0a1b2c": [{ address: "172.18.0.1", family: "IPv4", internal: false }],
  };
  assert.deepEqual(elsewhereOf("0.0.0.0", 7401, { interfaces, container: false }), ["http://192.0.2.10:7401", "http://198.51.100.7:7401"]);
  assert.deepEqual(elsewhereOf("::", 7401, { interfaces, container: false }), ["http://192.0.2.10:7401", "http://198.51.100.7:7401"]);
  assert.deepEqual(elsewhereOf("0.0.0.0", 7401, { interfaces, container: true }), [], "a container's addresses are its own network's");
  assert.deepEqual(elsewhereOf("127.0.0.1", 7401, { interfaces, container: false }), [], "a server on loopback is reached on this machine alone");
  assert.deepEqual(elsewhereOf("192.0.2.10", 7401, { interfaces, container: false }), [], "a server on one address prints that one");
});
