// Setup's offer to import this machine's sessions: a box in the console's setup, never ticked for the owner, on a server
// on this machine only. Nothing is imported unless the owner ticks it as they set the password; ticked, the sessions
// arrive, and the signed-in owner can read how the import stands.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { claudeSession, codexSession } from "./fixtures/import-sessions.mjs";
import { call, cookieOf, FAUX, scratch, serve } from "./support.mjs";

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

test("before its owner is set, a server on this machine says how many projects and sessions setup would import", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  // As the page's fetch sends it: no Origin and no body on a same-origin GET, only the browser's own Sec-Fetch-Site.
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
    assert.equal((await call(server.port, { path: "/v2/setup/import", headers: page(server) })).status, 404, "no offer once the owner is set");
    assert.equal((await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).status, 404, "and no import to report to the owner");
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
  assert.equal((await call(server.port, { path: "/v2/setup/import", headers: page(server) })).status, 404);
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { authorization: `Bearer ${server.token}`, ...json }, body: { password: PASSWORD, import: true } });
  assert.equal(made.status, 422, made.text);
  assert.equal(made.json.error.fields[0].field, "import");
  assert.equal(agentsIn(server.data), 0);
});

test("the counts are a read of the page only: a request with neither the browser's same-origin mark nor this server's Origin is refused", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  const at = (headers) => call(server.port, { path: "/v2/setup/import", headers });
  assert.equal((await at({})).status, 403, "no mark and no Origin, as a script sends it");
  assert.equal((await at({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await at({ origin: "https://evil.example" })).status, 403);
  assert.equal((await at({ origin: `http://127.0.0.1:${server.port}` })).status, 200, "this server's own Origin");
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
  assert.equal((await at(host, server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } })).status, 404);
  const asked = await at(host, server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD, import: true } });
  assert.equal(asked.status, 422, asked.text);
  assert.deepEqual([asked.json.error.fields[0].field, asked.json.error.fields[0].reason], ["import", "not_allowed"]);
  const session = await at(host, server.port, { path: "/v2/auth/session" });
  assert.equal(session.json.password_set, false, "the refusal set no owner");
  assert.equal(agentsIn(server.data), 0);
});

test("open setup with a public address, though it listens on loopback (behind a proxy), offers no import and refuses one asked for", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, publicUrl: "https://agents.example.test", ...(await machine(t)) });
  assert.equal((await call(server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } })).status, 404);
  const asked = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.equal(asked.status, 422, asked.text);
  assert.equal(asked.json.error.fields[0].field, "import");
  assert.equal(agentsIn(server.data), 0);
});

test("an import at setup that cannot open the store (held past its wait) is said, and the server goes on serving", { timeout: 60_000 }, async (t) => {
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
    const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
    assert.equal(made.status, 201, made.text);
    await sleep(6_500);
    assert.equal((await call(server.port, { path: "/v2/auth/session" })).status, 200, "the server is still up");
    assert.deepEqual((await call(server.port, { path: "/v2/setup/import", headers: { cookie: cookieOf(made) } })).json, { state: "stopped" }, "the owner reads it stopped");
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
});
