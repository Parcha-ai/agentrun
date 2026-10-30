// The setup page's offer to import this machine's sessions: a box, never ticked for the owner, on a server on this
// machine only. Nothing is imported unless the owner ticks it as they set the password; ticked, the sessions arrive.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
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
  const found = await call(server.port, { path: "/v2/setup/import", headers: page(server) });
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
