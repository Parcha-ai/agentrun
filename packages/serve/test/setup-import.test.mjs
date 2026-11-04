// Setup's offer to import this machine's sessions: a box in the console's setup, never ticked for the owner, on a server
// on this machine only. Nothing is imported unless the owner ticks it as they set the password; ticked, the sessions
// arrive, and the signed-in owner can read how the import stands.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { at as minute, claudeSession, claudeSubagent, codexSession, piSession } from "./fixtures/import-sessions.mjs";
import { call, cookieOf, FAUX, scratch, serve, withEnv } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const json = { "content-type": "application/json" };
const page = (server) => ({ ...json, origin: `http://127.0.0.1:${server.port}` });
const pw = (name) => `not-a-secret-${name}`;
const PASSWORD = pw("owner");

async function machine(t) {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(site, { recursive: true });
  claudeSession(home, site, 1);
  codexSession(home, site, 2);
  return { sessionsHome: { home, temp: join(root, "tmp") } };
}

const agentsIn = (data) => {
  const reader = openStoreReader(data);
  try {
    return reader.listAgents().length;
  } finally {
    reader.close();
  }
};

test("before its owner is set, a server on this machine says at once that it can import (202 while it counts), then how many projects and sessions", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  // As the page's fetch sends it: no Origin and no body on a same-origin GET, only the browser's own Sec-Fetch-Site.
  const read = () => call(server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  const first = await read();
  assert.deepEqual([first.status, first.json], [202, { counting: true }], "the first read starts the count and does not wait for it");
  let found = first;
  for (const deadline = Date.now() + 30_000; found.status === 202 && Date.now() < deadline; ) (await sleep(100), (found = await read()));
  assert.deepEqual([found.status, found.json], [200, { projects: 1, sessions: 2 }]);
});

test("a first start with countSessions counts before any read: the page's first read has the numbers", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, countSessions: true, ...(await machine(t)) });
  // Long enough for a worker to count two sessions on a busy machine, with no read to start it.
  await sleep(8_000);
  const found = await call(server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  assert.deepEqual([found.status, found.json], [200, { projects: 1, sessions: 2 }]);
});

test("setting the password without the box imports nothing", async (t) => {
  for (const body of [{ password: PASSWORD }, { password: PASSWORD, import: false }]) {
    const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
    const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body });
    assert.deepEqual([made.status, made.json], [201, { signed_in: true }], made.text);
    await sleep(500);
    assert.equal(agentsIn(server.data), 0, `nothing imported for ${JSON.stringify(body)}`);
    assert.equal((await call(server.port, { path: "/v2/setup/import", headers: page(server) })).status, 404, "nothing to a browser that is not signed in");
    // The owner's first page reads it: no import asked is an answer, never a 404 the browser logs as an error.
    const none = await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } });
    assert.deepEqual([none.status, none.json], [200, { offer: false }], "and no import to report to the owner");
  }
});

test("with the box ticked, the sessions arrive as agents after the password is set, and the signed-in owner reads the import running, then done", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.deepEqual([made.status, made.json], [201, { signed_in: true, importing: true }], made.text);
  const state = async () => (await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json;
  assert.ok(["running", "done"].includes((await state()).state));
  for (const deadline = Date.now() + 30_000; (await state()).state === "running" && Date.now() < deadline; ) await sleep(100);
  assert.deepEqual(await state(), { state: "done", agents: 1, runs: 2, skipped: 0 });
  assert.equal((await call(server.port, { path: "/v2/setup/import", headers: page(server) })).status, 404, "not to a browser that is not signed in");
  const deadline = Date.now() + 30_000;
  while (agentsIn(server.data) === 0 && Date.now() < deadline) await sleep(100);
  const reader = openStoreReader(server.data);
  t.after(() => reader.close());
  const [agent] = reader.listAgents();
  assert.equal(agent?.name, "acme-site");
  for (const deadlineRuns = Date.now() + 30_000; reader.listRuns().length < 2 && Date.now() < deadlineRuns; ) await sleep(100);
  assert.deepEqual(reader.listRuns().map((r) => r.importedFrom.source).sort(), ["claude-code", "codex"]);
});

test("a server at a public address offers no import, and refuses one asked for", async (t) => {
  const server = await serve(t, { accounts: true, publicUrl: "https://agents.example.test", ...(await machine(t)) });
  const offer = await call(server.port, { path: "/v2/setup/import", headers: page(server) });
  assert.deepEqual([offer.status, offer.json], [200, { offer: false }], "no offer, said as an answer and not a 404");
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { authorization: `Bearer ${server.token}`, ...json }, body: { password: PASSWORD, import: true } });
  assert.equal(made.status, 422, made.text);
  assert.equal(made.json.error.fields[0].field, "import");
  assert.equal(agentsIn(server.data), 0);
  const set = await call(server.port, { method: "POST", path: "/v2/setup", headers: { authorization: `Bearer ${server.token}`, ...json }, body: { password: PASSWORD } });
  assert.equal(set.status, 201, set.text);
  const after = await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(set) } });
  assert.deepEqual([after.status, after.json], [200, { offer: false }], "nor to its signed-in owner");
});

test("the counts are a read of the page only: a request with neither the browser's same-origin mark nor this server's Origin is refused", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  const at = (headers) => call(server.port, { path: "/v2/setup/import", headers });
  assert.equal((await at({})).status, 403, "no mark and no Origin, as a script sends it");
  assert.equal((await at({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await at({ origin: "https://evil.example" })).status, 403);
  assert.ok([200, 202].includes((await at({ origin: `http://127.0.0.1:${server.port}` })).status), "this server's own Origin");
});

/** An address of this machine's own bridge (Docker's), reachable from this host and its containers only, never a
 *  public one; else the first non-loopback IPv4 one (a container's own). */
function bridgeAddress() {
  const all = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, address: a.address })));
  return (all.find((a) => /^(docker|br-)/.test(a.name)) ?? all[0])?.address;
}
const at = (host, port, { method = "GET", path, headers = {}, body }) =>
  new Promise((resolve, reject) => {
    const req = request({ host, port, method, path, headers: { host: `${host}:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => (text += chunk)).on("end", () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.once("error", reject).end(body === undefined ? undefined : JSON.stringify(body));
  });

test("open setup on an address other than loopback offers no import and refuses one asked for, and leaves the owner unset", { skip: bridgeAddress() ? false : "no address but loopback here" }, async (t) => {
  const host = bridgeAddress();
  const server = await serve(t, { accounts: true, openSetup: true, host, ...(await machine(t)) });
  const origin = `http://${host}:${server.port}`;
  const offer = await at(host, server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  assert.deepEqual([offer.status, offer.json], [200, { offer: false }]);
  const asked = await at(host, server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD, import: true } });
  assert.equal(asked.status, 422, asked.text);
  assert.deepEqual([asked.json.error.fields[0].field, asked.json.error.fields[0].reason], ["import", "not_allowed"]);
  const session = await at(host, server.port, { path: "/v2/auth/session" });
  assert.equal(session.json.password_set, false, "the refusal set no owner");
  assert.equal(agentsIn(server.data), 0);
});

test("open setup with a public address, though it listens on loopback (behind a proxy), offers no import and refuses one asked for", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, publicUrl: "https://agents.example.test", ...(await machine(t)) });
  const offer = await call(server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  assert.deepEqual([offer.status, offer.json], [200, { offer: false }]);
  const asked = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.equal(asked.status, 422, asked.text);
  assert.equal(asked.json.error.fields[0].field, "import");
  assert.equal(agentsIn(server.data), 0);
});

test("an import at setup that cannot open the store (held past its wait) holds up no request, is said, and the server goes on serving", { timeout: 60_000 }, async (t) => {
  // A rejection nothing handles would end a server: the import's own failure must be handled where it happens.
  const unhandled = [];
  const listen = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  t.after(() => process.off("unhandledRejection", listen));
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  // Another writer holds the store past the import's five-second wait.
  const holder = new DatabaseSync(join(server.data, "store.sqlite"));
  holder.exec("BEGIN EXCLUSIVE");
  try {
    const asked = Date.now();
    const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
    assert.equal(made.status, 201, made.text);
    // The import waits for the store on its own thread: the setup's answer and the next request do not.
    assert.equal((await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json.state, "running");
    assert.ok(Date.now() - asked < 3_000, `answered in ${Date.now() - asked} ms while the store is held`);
    // Held until the import has given up: past its five-second wait, plus its thread's start on a busy machine.
    const state = async () => (await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json;
    for (const deadline = Date.now() + 20_000; (await state()).state === "running" && Date.now() < deadline; ) await sleep(200);
    assert.equal((await call(server.port, { path: "/v2/auth/session" })).status, 200, "the server is still up");
    assert.deepEqual(await state(), { state: "stopped" }, "the owner reads it stopped");
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  assert.deepEqual(unhandled.map(String), [], "no rejection left unhandled");
  assert.equal(agentsIn(server.data), 0);
  assert.ok(existsSync(join(server.data, ".import-at-setup")), "the owner's yes is kept for the next start");
});

test("the owner's yes outlives a stop: the next start goes on with the import, and clears it once done", { timeout: 60_000 }, async (t) => {
  const { sessionsHome } = await machine(t);
  const data = join(await scratch(t), "agents");
  mkdirSync(data, { recursive: true });
  // As a server stopped mid-import leaves it.
  writeFileSync(join(data, ".import-at-setup"), "", { mode: 0o600 });
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", accounts: true, openSetup: true, sessionsHome });
  t.after(() => server.close());
  for (const deadline = Date.now() + 30_000; existsSync(join(data, ".import-at-setup")) && Date.now() < deadline; ) await sleep(100);
  assert.equal(existsSync(join(data, ".import-at-setup")), false, "cleared once the import ended");
  const reader = openStoreReader(data);
  t.after(() => reader.close());
  assert.deepEqual(reader.listRuns().map((r) => r.importedFrom.source).sort(), ["claude-code", "codex"]);
});

test("a server closed during the import at setup stops it between sessions and waits for it: nothing writes the store after close", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(site, { recursive: true });
  for (let n = 1; n <= 40; n++) claudeSession(home, site, n, { prompt: `Task ${n}.` });
  const data = join(root, "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", accounts: true, openSetup: true, sessionsHome: { home, temp: join(root, "tmp") } });
  let closed = false;
  t.after(() => (closed ? undefined : server.close()));
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.equal(made.status, 201, made.text);
  await server.close();
  closed = true;
  const count = () => {
    const reader = openStoreReader(data);
    try {
      return reader.listRuns().length;
    } finally {
      reader.close();
    }
  };
  const atClose = count();
  await sleep(1_500);
  assert.equal(count(), atClose, "no run written after close");
  assert.equal(existsSync(join(data, ".import-at-setup")), atClose < 40, "the yes is kept while the import is unfinished");
  // Waited for, not ended: the stopped import answered what it took, and the yes keeps it (setup wrote it empty).
  if (atClose < 40) assert.equal(JSON.parse(readFileSync(join(data, ".import-at-setup"), "utf8") || "{}").runs, atClose, "the import stopped between sessions and said so");
});

test("a setup with the box ticked still being answered when the server closes starts no import after close: the yes waits for the next start", { timeout: 60_000 }, async (t) => {
  const { sessionsHome } = await machine(t);
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", accounts: true, openSetup: true, sessionsHome });
  // Close begins as the request is in, most often while it hashes the password; its handler goes on after its
  // connection is cut. Whichever way it fell, nothing writes the store after close.
  const asked = call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } }).catch(() => undefined);
  await sleep(10);
  await server.close();
  await asked;
  await sleep(2_000);
  assert.equal(agentsIn(data), 0, "no agent written after close");
  // Setup took the yes (the password is set) exactly when it is kept for the next start.
  const owner = join(data, "owner.json");
  const set = existsSync(owner) && JSON.parse(readFileSync(owner, "utf8")).password !== undefined;
  assert.equal(existsSync(join(data, ".import-at-setup")), set, set ? "the owner's yes is kept for the next start" : "no yes was taken");
});

test("a server that fails to listen takes up no import and starts no count: it has no close to stop them", { timeout: 60_000 }, async (t) => {
  const { sessionsHome } = await machine(t);
  const data = join(await scratch(t), "agents");
  mkdirSync(data, { recursive: true });
  // The owner's yes from a server stopped mid-import, and a port another process holds.
  writeFileSync(join(data, ".import-at-setup"), "", { mode: 0o600 });
  const { createServer } = await import("node:net");
  const taken = createServer();
  await new Promise((done) => taken.listen(0, "127.0.0.1", done));
  t.after(() => taken.close());
  await assert.rejects(startServe({ data, port: taken.address().port, faux: FAUX, drainTimeout: "5s", accounts: true, openSetup: true, countSessions: true, sessionsHome }), /EADDRINUSE/);
  await sleep(3_000);
  assert.equal(agentsIn(data), 0, "nothing imported by a server that never started");
  assert.ok(existsSync(join(data, ".import-at-setup")), "the yes is kept for a start that listens");
});

test("under its launcher (node started from a string), setup counts this machine's sessions and imports them, and the worker prints nothing", { timeout: 90_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(site, { recursive: true });
  claudeSession(home, site, 1);
  codexSession(home, site, 2);
  piSession(home, site, 3);
  // Its own temp directory, apart from the home: a project under the temp directory is left out.
  const [data, config, temp] = [join(root, "agents"), join(root, "config"), join(root, "tmp")];
  mkdirSync(temp, { recursive: true });
  const { AGENTRUN_PUBLIC_URL: _, RENDER_EXTERNAL_URL: __, AGENTRUN_TOKEN: ___, ...inherited } = process.env;
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0"], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited, HOME: home, TMPDIR: temp, XDG_CONFIG_HOME: config } });
  // Its group is signalled only while it is alive: once it has exited, the group's number may be another's.
  let alive = true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve((alive = false))));
  t.after(async () => {
    if (alive) process.kill(-child.pid, "SIGTERM");
    await exited;
  });
  let [out, err] = ["", ""];
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (const deadline = Date.now() + 30_000; !/AGENTRUN_BASE_URL=http:\/\/[^:]+:(\d+)/.test(out); ) {
    assert.ok(Date.now() < deadline, `the server started: ${out}${err}`);
    await sleep(50);
  }
  const port = Number(/AGENTRUN_BASE_URL=http:\/\/[^:]+:(\d+)/.exec(out)[1]);
  const read = () => call(port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  let found = await read();
  for (const deadline = Date.now() + 30_000; found.status === 202 && Date.now() < deadline; ) (await sleep(100), (found = await read()));
  assert.deepEqual([found.status, found.json], [200, { projects: 1, sessions: 3 }], err);
  const made = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin: `http://127.0.0.1:${port}` }, body: { password: PASSWORD, import: true } });
  assert.deepEqual([made.status, made.json], [201, { signed_in: true, importing: true }], made.text);
  const state = async () => (await call(port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json;
  for (const deadline = Date.now() + 30_000; (await state()).state === "running" && Date.now() < deadline; ) await sleep(100);
  assert.deepEqual(await state(), { state: "done", agents: 1, runs: 3, skipped: 0 }, err);
  assert.equal(err, "", "no line on stderr: no refused worker, no node:sqlite warning");
});

test("a server whose process runs with flags a worker may not take (as a test runner's child does on Node 24) still counts and imports: its worker inherits what Node passes on", { timeout: 90_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(site, { recursive: true });
  claudeSession(home, site, 1);
  codexSession(home, site, 2);
  const script = join(root, "serve.mjs");
  writeFileSync(
    script,
    `import { startServe } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const serve = await startServe({ data: ${JSON.stringify(join(root, "agents"))}, port: 0, faux: ${JSON.stringify(FAUX)}, accounts: true, openSetup: true, sessionsHome: { home: ${JSON.stringify(home)}, temp: ${JSON.stringify(join(root, "tmp"))} } });
console.log(\`port \${serve.port}\`);
process.on("SIGTERM", () => void serve.close().then(() => process.exit(0)));
`,
  );
  // --stack-trace-limit is a V8 flag: given to a worker by name, Node refuses the worker.
  const child = spawn(process.execPath, ["--stack-trace-limit=10", script], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => (child.kill("SIGTERM"), await exited));
  let [out, err] = ["", ""];
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (const deadline = Date.now() + 30_000; !/port (\d+)/.test(out); ) {
    assert.ok(Date.now() < deadline, `the server started: ${out}${err}`);
    await sleep(50);
  }
  const port = Number(/port (\d+)/.exec(out)[1]);
  const read = () => call(port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  let found = await read();
  for (const deadline = Date.now() + 30_000; found.status === 202 && Date.now() < deadline; ) (await sleep(100), (found = await read()));
  assert.deepEqual([found.status, found.json], [200, { projects: 1, sessions: 2 }], err);
  const made = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin: `http://127.0.0.1:${port}` }, body: { password: PASSWORD, import: true } });
  assert.deepEqual([made.status, made.json], [201, { signed_in: true, importing: true }], made.text);
  const state = async () => (await call(port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json;
  for (const deadline = Date.now() + 30_000; (await state()).state === "running" && Date.now() < deadline; ) await sleep(100);
  assert.deepEqual(await state(), { state: "done", agents: 1, runs: 2, skipped: 0 }, err);
});

/** Every file under `dir` that holds `value`, by its path under `dir`. */
const holding = (dir, value) => {
  const found = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (readFileSync(path).includes(value)) found.push(path.slice(dir.length + 1));
    }
  };
  walk(dir);
  return found;
};

test("a server stopped while setup counts a big home's sessions exits within its drain window: the count reads no session for keys", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "big");
  mkdirSync(site, { recursive: true });
  claudeSession(home, site, 1);
  // 200 subagent files of about a megabyte each: a key scan over them takes many seconds, a count's listing none.
  const notes = Array.from({ length: 20_000 }, (_, i) => `line ${i} of the subagent's notes, read and kept`).join("\n");
  for (let k = 1; k <= 200; k++) claudeSubagent(home, site, 1, k, { answer: notes });
  const [data, config, temp] = [join(root, "agents"), join(root, "config"), join(root, "tmp")];
  mkdirSync(temp, { recursive: true });
  // The server's own drain window, set short: it answers SIGTERM within it.
  const [DRAIN, DRAIN_MS] = ["2s", 2_000];
  const { AGENTRUN_PUBLIC_URL: _, RENDER_EXTERNAL_URL: __, AGENTRUN_TOKEN: ___, ...inherited } = process.env;
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0", "--drain-timeout", DRAIN], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited, HOME: home, TMPDIR: temp, XDG_CONFIG_HOME: config } });
  // Its group is signalled only while it is alive: once it has exited, the group's number may be another's.
  let alive = true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve((alive = false))));
  t.after(async () => {
    if (alive) process.kill(-child.pid, "SIGKILL");
    await exited;
  });
  let [out, err] = ["", ""];
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (const deadline = Date.now() + 30_000; !/AGENTRUN_BASE_URL=http:\/\/[^:]+:(\d+)/.test(out); ) {
    assert.ok(Date.now() < deadline, `the server started: ${out}${err}`);
    await sleep(50);
  }
  const port = Number(/AGENTRUN_BASE_URL=http:\/\/[^:]+:(\d+)/.exec(out)[1]);
  // A server the CLI starts with no owner counts as it starts: stopped while that count runs.
  const read = await call(port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  assert.ok([200, 202].includes(read.status), read.text);
  const stopped = Date.now();
  if (alive) process.kill(-child.pid, "SIGTERM");
  const outcome = await Promise.race([exited.then(() => "exited"), sleep(DRAIN_MS + 1_500).then(() => "still running")]);
  assert.equal(outcome, "exited", `${Date.now() - stopped} ms after SIGTERM with a ${DRAIN} drain window (the count ${read.status === 202 ? "running" : "done"} when stopped)`);
});

test("a server stopped while setup still lists a home's session files exits at once: the count, which writes nothing, is ended, not waited for", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "many");
  mkdirSync(site, { recursive: true });
  claudeSession(home, site, 1);
  // 120,000 empty session files: a count lists and stats every one before it reads any, for seconds.
  const many = join(home, ".claude", "projects", "-many");
  mkdirSync(many, { recursive: true });
  for (let k = 0; k < 120_000; k++) writeFileSync(join(many, `${k}.jsonl`), "");
  const [data, config, temp] = [join(root, "agents"), join(root, "config"), join(root, "tmp")];
  mkdirSync(temp, { recursive: true });
  const { AGENTRUN_PUBLIC_URL: _, RENDER_EXTERNAL_URL: __, AGENTRUN_TOKEN: ___, ...inherited } = process.env;
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0"], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited, HOME: home, TMPDIR: temp, XDG_CONFIG_HOME: config } });
  // Its group is signalled only while it is alive: once it has exited, the group's number may be another's.
  let alive = true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve((alive = false))));
  t.after(async () => {
    if (alive) process.kill(-child.pid, "SIGKILL");
    await exited;
  });
  let [out, err] = ["", ""];
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (const deadline = Date.now() + 30_000; !/AGENTRUN_BASE_URL=http:\/\/[^:]+:(\d+)/.test(out); ) {
    assert.ok(Date.now() < deadline, `the server started: ${out}${err}`);
    await sleep(50);
  }
  const port = Number(/AGENTRUN_BASE_URL=http:\/\/[^:]+:(\d+)/.exec(out)[1]);
  // A server the CLI starts with no owner counts as it starts: stopped while that count still lists.
  const read = await call(port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  assert.deepEqual([read.status, read.json], [202, { counting: true }], read.text);
  const stopped = Date.now();
  if (alive) process.kill(-child.pid, "SIGTERM");
  // Unreferenced: the bound holds no exited test's process open.
  const outcome = await Promise.race([exited.then(() => "exited"), sleep(5_000, "still running", { ref: false })]);
  assert.equal(outcome, "exited", `${Date.now() - stopped} ms after SIGTERM, the count still listing`);
  assert.doesNotMatch(err, /the count of this machine's sessions failed/, "an ended count is no failed one");
});

test("under its launcher, setup's import cuts each of the server's own secrets out of everything it writes: a session's text, the project's instructions and its skills", { timeout: 90_000 }, async (t) => {
  // A value of its own for every name the launcher protects (its SECRETS line), each handed over its pipe: no environment
  // of the server's has one. The seal key is one a server takes: 32 bytes in base64.
  const names = /^SECRETS='([A-Z0-9_ ]+)'$/m.exec(readFileSync(LAUNCHER, "utf8"))[1].split(" ").filter(Boolean);
  const keys = Object.fromEntries(names.map((name) => [name, name === "AGENTRUN_SEAL_KEY" ? randomBytes(32).toString("base64") : `not-a-secret-${name.toLowerCase()}-${randomBytes(8).toString("hex")}`]));
  const KEY = Object.values(keys).join(" ");
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(join(site, ".claude", "skills", "deploy"), { recursive: true });
  writeFileSync(join(site, "CLAUDE.md"), `Deploy with ${KEY}.\n`);
  writeFileSync(join(site, ".claude", "skills", "deploy", "SKILL.md"), `---\nname: deploy\n---\nThe key is ${KEY}.\n`);
  claudeSession(home, site, 1, { output: `README.md (env ${KEY})`, env: { OPENAI_API_KEY: KEY } });
  const [data, config, temp] = [join(root, "agents"), join(root, "config"), join(root, "tmp")];
  mkdirSync(temp, { recursive: true });
  const { AGENTRUN_PUBLIC_URL: _, RENDER_EXTERNAL_URL: __, AGENTRUN_TOKEN: ___, ...inherited } = process.env;
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0"], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited, HOME: home, TMPDIR: temp, XDG_CONFIG_HOME: config, ...keys } });
  // Its group is signalled only while it is alive: once it has exited, the group's number may be another's.
  let alive = true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve((alive = false))));
  t.after(async () => {
    if (alive) process.kill(-child.pid, "SIGTERM");
    await exited;
  });
  let [out, err] = ["", ""];
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (const deadline = Date.now() + 30_000; !/AGENTRUN_BASE_URL=http:\/\/[^:]+:(\d+)/.test(out); ) {
    assert.ok(Date.now() < deadline, `the server started: ${out}${err}`);
    await sleep(50);
  }
  const port = Number(/AGENTRUN_BASE_URL=http:\/\/[^:]+:(\d+)/.exec(out)[1]);
  const made = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin: `http://127.0.0.1:${port}` }, body: { password: PASSWORD, import: true } });
  assert.deepEqual([made.status, made.json], [201, { signed_in: true, importing: true }], made.text);
  const state = async () => (await call(port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json;
  for (const deadline = Date.now() + 30_000; (await state()).state === "running" && Date.now() < deadline; ) await sleep(100);
  assert.deepEqual(await state(), { state: "done", agents: 1, runs: 1, skipped: 0 }, err);
  for (const [name, value] of Object.entries(keys)) assert.deepEqual(holding(data, value), [], `no file under the data directory holds ${name}'s value`);
});

test("a key saved on the Tool keys page is cut out of everything setup's import writes, and so is the server's own key of the same name when it differs: a session's text and title, its subagent's file, and a session named after its file, kept under a redacted- id that the next start's import finds again", { timeout: 90_000 }, async (t) => {
  // Built here, so no scanner reads either as a credential.
  const saved = ["not-a-secret", "monid", randomBytes(8).toString("hex")].join("-");
  const own = ["not-a-secret", "monid-own", randomBytes(8).toString("hex")].join("-");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["MONID_API_KEY"]);
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(site, { recursive: true });
  claudeSession(home, site, 1, { prompt: `Use ${saved} to list the files.`, output: `README.md (with ${saved}, then ${own})` });
  claudeSubagent(home, site, 1, 1, { answer: `It is ${saved}.` });
  // A session file whose records carry no session id, named with the key: the import names the session after its file.
  const unnamed = claudeSession(home, site, 2, { prompt: "Check the logs." });
  const lines = readFileSync(unnamed, "utf8").trimEnd().split("\n").map((line) => {
    const { sessionId: _, ...rest } = JSON.parse(line);
    return JSON.stringify(rest);
  });
  rmSync(unnamed);
  const named = join(dirname(unnamed), `${saved}.jsonl`);
  writeFileSync(named, `${lines.join("\n")}\n`);
  utimesSync(named, new Date(minute(10)), new Date(minute(10)));
  const data = join(root, "agents");
  const start = () => startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", accounts: true, openSetup: true, sessionsHome: { home, temp: join(root, "tmp") } });
  let server = await start();
  t.after(() => server.close());
  const kept = await call(server.port, { method: "PUT", path: "/v2/settings/tool-keys/monid", headers: { ...json, authorization: `Bearer ${server.token}` }, body: { values: { MONID_API_KEY: saved } } });
  assert.equal(kept.status, 204, kept.text);
  // The server starts again with a MONID_API_KEY of its own, a different value: the saved one stays in the page's file.
  await server.close();
  process.env.MONID_API_KEY = own;
  server = await start();
  // Setup's count, by the ids as the import keeps them.
  const read = () => call(server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  let counted = await read();
  for (const deadline = Date.now() + 30_000; counted.status === 202 && Date.now() < deadline; ) (await sleep(100), (counted = await read()));
  assert.deepEqual([counted.status, counted.json], [200, { projects: 1, sessions: 2 }]);
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.deepEqual([made.status, made.json], [201, { signed_in: true, importing: true }], made.text);
  const state = async () => (await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json;
  for (const deadline = Date.now() + 30_000; (await state()).state === "running" && Date.now() < deadline; ) await sleep(100);
  assert.deepEqual(await state(), { state: "done", agents: 1, runs: 2, skipped: 0 });
  const nowhere = (when) => {
    const names = [];
    const walk = (at) => {
      for (const name of readdirSync(at)) {
        names.push(name);
        if (statSync(join(at, name)).isDirectory()) walk(join(at, name));
      }
    };
    walk(data);
    for (const [which, value] of [["the saved key", saved], ["the server's own", own]]) assert.deepEqual([holding(data, value), names.filter((name) => name.includes(value))], [[], []], `${when}: no file under the data directory holds ${which}, or is named after it`);
  };
  nowhere("the first import");
  assert.ok(holding(join(data, "runs"), "[redacted]").length > 0, "[redacted] where it was");
  const sessions = () => {
    const reader = openStoreReader(data);
    try {
      return reader.listRuns().map((run) => run.importedFrom.session).sort();
    } finally {
      reader.close();
    }
  };
  const first = sessions();
  assert.equal(first.filter((id) => /^redacted-[0-9a-f]{16}$/.test(id)).length, 1, "the session named after its file, under its id as kept");
  // The file named with the key grows by a turn; setup's import, gone on with at the next start, finds the run the first
  // made of it under the id as kept: no second run of it.
  const last = JSON.parse(lines.at(-1));
  appendFileSync(named, `${JSON.stringify({ ...last, type: "user", uuid: "u9-2", parentUuid: last.uuid ?? null, timestamp: minute(9), message: { role: "user", content: "One more thing." } })}\n`);
  utimesSync(named, new Date(minute(20)), new Date(minute(20)));
  await server.close();
  writeFileSync(join(data, ".import-at-setup"), "", { mode: 0o600 });
  server = await start();
  for (const deadline = Date.now() + 30_000; existsSync(join(data, ".import-at-setup")) && Date.now() < deadline; ) await sleep(100);
  assert.equal(existsSync(join(data, ".import-at-setup")), false, "the next start's import ended");
  assert.deepEqual(sessions(), first, "no run made twice");
  nowhere("the next start's import");
});

test("setup counts sessions as the import takes them: a thread resumed in a second file of the same id is one session", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(site, { recursive: true });
  claudeSession(home, site, 1);
  const first = codexSession(home, site, 2);
  // The thread resumed in a file of its own under the same id.
  const resumed = codexSession(home, site, 3);
  const records = readFileSync(resumed, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)).map((r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id: JSON.parse(readFileSync(first, "utf8").split("\n")[0]).payload.id } } : r));
  writeFileSync(resumed, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const old = new Date(Date.now() - 60 * 60_000);
  for (const file of [first, resumed]) utimesSync(file, old, old);
  const server = await serve(t, { accounts: true, openSetup: true, sessionsHome: { home, temp: join(root, "tmp") } });
  const read = () => call(server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  let found = await read();
  for (const deadline = Date.now() + 30_000; found.status === 202 && Date.now() < deadline; ) (await sleep(100), (found = await read()));
  assert.deepEqual([found.status, found.json], [200, { projects: 1, sessions: 2 }], "the Claude Code session and the thread, not its two files");
});

test("a setup with the box ticked that cannot keep the owner's yes sets no owner: it fails whole, and a retry sets the owner and imports", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  // A directory where the yes is kept: writing it fails.
  const yes = join(server.data, ".import-at-setup");
  mkdirSync(yes);
  const failed = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.ok(failed.status >= 500, `${failed.status} ${failed.text}`);
  const session = await call(server.port, { path: "/v2/auth/session", headers: page(server) });
  assert.equal(session.json.password_set, false, "no owner was set");
  rmSync(yes, { recursive: true });
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.deepEqual([made.status, made.json], [201, { signed_in: true, importing: true }], made.text);
  const state = async () => (await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json;
  for (const deadline = Date.now() + 30_000; (await state()).state === "running" && Date.now() < deadline; ) await sleep(100);
  assert.deepEqual(await state(), { state: "done", agents: 1, runs: 2, skipped: 0 });
});

test("an import at setup stopped part way and gone on with at the next start says what the whole import took", { timeout: 90_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(site, { recursive: true });
  for (let n = 1; n <= 60; n++) claudeSession(home, site, n, { prompt: `Task ${n}.` });
  const data = join(root, "agents");
  const options = { data, port: 0, faux: FAUX, drainTimeout: "5s", accounts: true, openSetup: true, sessionsHome: { home, temp: join(root, "tmp") } };
  const runs = () => {
    if (!existsSync(join(data, "store.sqlite"))) return 0;
    const reader = openStoreReader(data);
    try {
      return reader.listRuns().length;
    } finally {
      reader.close();
    }
  };
  const first = await startServe(options);
  const made = await call(first.port, { method: "POST", path: "/v2/setup", headers: page(first), body: { password: PASSWORD, import: true } });
  assert.equal(made.status, 201, made.text);
  // Stopped once some sessions are in, not all.
  for (const deadline = Date.now() + 30_000; runs() === 0 && Date.now() < deadline; ) await sleep(20);
  await first.close();
  const before = runs();
  assert.ok(before > 0 && before < 60, `stopped part way: ${before} of 60 in`);
  const second = await startServe(options);
  t.after(() => second.close());
  const signedIn = await call(second.port, { method: "POST", path: "/v2/auth/sign-in", headers: page(second), body: { password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);
  const state = async () => (await call(second.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(signedIn) } })).json;
  for (const deadline = Date.now() + 60_000; (await state())?.state !== "done" && Date.now() < deadline; ) await sleep(100);
  assert.deepEqual(await state(), { state: "done", agents: 1, runs: 60, skipped: 0 }, "every session, the first start's part included");
});
