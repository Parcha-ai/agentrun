// The setup page's offer to import this machine's sessions: a box, never ticked for the owner, on a server on this
// machine only. Nothing is imported unless the owner ticks it as they set the password; ticked, the sessions arrive.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { claudeSession, codexSession } from "./fixtures/import-sessions.mjs";
import { call, scratch, serve } from "./support.mjs";

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

test("the setup page carries the box hidden and unticked; a server on this machine says what it would import", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  const html = (await call(server.port, { path: "/setup" })).text;
  const box = html.match(/<label class="field check" id="import-field" hidden>.*?<\/label>/s)?.[0];
  assert.ok(box, "the box, hidden until the server says it has sessions");
  assert.match(box, /<input type="checkbox" name="import">/);
  assert.doesNotMatch(box, /checked/, "never ticked for the owner");
  // As the page's fetch sends it: no Origin and no body on a same-origin GET, only the browser's own Sec-Fetch-Site.
  const found = await call(server.port, { path: "/v2/setup/import", headers: { "sec-fetch-site": "same-origin" } });
  assert.deepEqual([found.status, found.json], [200, { projects: 1, sessions: 2 }]);
});

test("setting the password without the box imports nothing", async (t) => {
  for (const body of [{ password: PASSWORD }, { password: PASSWORD, import: false }]) {
    const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
    const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body });
    assert.equal(made.status, 201, made.text);
    await sleep(500);
    assert.equal(agentsIn(server.data), 0, `nothing imported for ${JSON.stringify(body)}`);
    assert.equal((await call(server.port, { path: "/v2/setup/import", headers: page(server) })).status, 404, "no offer once the owner is set");
  }
});

test("with the box ticked, the sessions arrive as agents after the password is set", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, ...(await machine(t)) });
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.equal(made.status, 201, made.text);
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
