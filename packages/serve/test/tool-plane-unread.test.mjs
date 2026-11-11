// The server's tool settings file present but unreadable (not JSON, or not an object): every tool takes its defaults, and
// nothing reads past an ask it can't see behind. The gate fails closed (it keeps the last good read, none at a start);
// the plane must too. Under approvals "never" an ask is lifted only where nothing stands behind it, and an unread file
// may hold a deny, so with the settings unread the plane resolves as under ask: no harness's own (native) search, which
// runs inside its CLI, outside the gate.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { permissionFrom } from "../dist/tool-gate.js";
import { checkToolSettings, NATIVE_ASKS, planeFor, relaunchPlane, TOOL_SETTINGS_KEY } from "../dist/tool-plane.js";
import { storedSettings } from "./gate-support.mjs";
import { openSqliteStore, STORE_FILE } from "../dist/store/sqlite/store.js";
import { fauxTable } from "./fixtures/faux-table.mjs";
import { agent, serve } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), harnessTable: fauxTable(fixture("faux-gate.mjs")), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };

/** The server's settings as the runner reads them from the store whose row holds `value` (undefined: no row). */
const settingsFrom = (value) => storedSettings(value).settings;

test("unread server settings: an ask is never lifted under never, in the gate's permission and in the plane (planeFor, relaunchPlane)", () => {
  const unread = settingsFrom("{ not json");
  const notObject = settingsFrom([]);
  const readable = settingsFrom({});
  const missing = settingsFrom(undefined);
  const own = { web_search: { provider: "native", permission: "ask" } };
  for (const [label, map] of [["not JSON", unread], ["not an object", notObject]]) {
    assert.deepEqual(permissionFrom("web_search", map, own, "never"), { permission: "ask", from: "agent" }, `${label}: never lifts no ask over unread settings`);
    assert.deepEqual(permissionFrom("web_fetch", map, {}, "never").permission, permissionFrom("web_fetch", map, {}, "ask").permission, `${label}: a default ask stays as under ask`);
  }
  // No row is every default, read: never lifts its ask as before.
  assert.deepEqual(permissionFrom("web_search", missing, own, "never"), { permission: "allow", from: "unattended" }, "no row is read: never lifts the ask");
  assert.deepEqual(permissionFrom("web_search", readable, own, "never"), { permission: "allow", from: "unattended" }, "a row that reads: never lifts the ask");
  // The plane: under unread settings, never resolves web_search as ask does, on each harness whose search is its CLI's.
  for (const harness of ["claude-agent", "codex"]) {
    const tooling = (approvals) => ({ harness, tools: ["web_search"], overrides: own, ...(approvals === "never" ? { approvals } : {}) });
    const env = process.env;
    const asked = planeFor(env, tooling("ask"), unread, { run: true }).web_search;
    assert.equal(asked, NATIVE_ASKS, `${harness}: under ask, native search is held off (it cannot wait for an approval)`);
    assert.equal(planeFor(env, tooling("never"), unread, { run: true }).web_search, asked, `${harness}: never over unread settings resolves as ask`);
    assert.equal(relaunchPlane(undefined, env, tooling("never"), unread, { first: true }).web_search, asked, `${harness}: a relaunch the same`);
    assert.notEqual(planeFor(env, tooling("never"), readable, { run: true }).web_search, NATIVE_ASKS, `${harness}: with the settings read, never lifts the ask as before`);
  }
});

test("a server started on a stored tool-settings row that does not read: a never agent with native web_search on claude-agent and codex is held to ask (the native-ask warning, no CLI search); a PUT of the settings lifts it", { timeout: 120_000 }, async (t) => {
  const first = await serve(t, GATE);
  const { data } = first;
  await first.close();
  // A row that is not an object of tools to their settings (tool-plane.ts checkToolSettings), as a hand-edited store holds it.
  const planted = await openSqliteStore({ file: join(data, STORE_FILE), role: "server" });
  await planted.settings.put(TOOL_SETTINGS_KEY, "{ not json");
  await planted.close();
  const { api } = await serve(t, { ...GATE, data });
  const NATIVE_ASKS_WORDS = /native search cannot wait for an approval/;
  for (const harness of ["claude-agent", "codex"]) {
    const native = { harness, tools: ["web_search"], tool_settings: { web_search: { provider: "native", permission: "ask" } }, approvals: "never" };
    const saved = await api("POST", "/agents", agent(`unread-${harness}`, native));
    assert.equal(saved.status, 201, `${harness}: ${JSON.stringify(saved.body)}`);
    assert.ok((saved.body.warnings ?? []).some((w) => NATIVE_ASKS_WORDS.test(w.message ?? "")), `${harness}: unread settings hold never to ask: ${JSON.stringify(saved.body.warnings)}`);
    const tools = (await api("GET", `/agents/unread-${harness}`)).body.tools ?? [];
    const search = tools.find((tool) => tool.name === "web_search");
    assert.equal(search?.permission, "ask", `${harness}: the agent read says ask, not an unattended allow: ${JSON.stringify(search)}`);
  }
  // A PUT replaces the unread row: the settings read again, and never lifts the ask as before.
  assert.equal((await api("PUT", "/settings/tools", {})).status, 200);
  const after = (await api("GET", "/agents/unread-codex")).body.tools.find((tool) => tool.name === "web_search");
  assert.deepEqual([after?.permission, after?.permission_from], ["allow", "unattended"], `after a PUT the settings read: ${JSON.stringify(after)}`);
});

test("a direct read of unread settings (checkToolSettings, as learning's draft check and the learned-draft tools read them) carries the mark too: never lifts no ask over it", () => {
  for (const [label, body] of [["not JSON", "{ not json"], ["not an object", [1, 2]]]) {
    const read = checkToolSettings(body, "the stored tool settings");
    assert.equal(read.unreadable, true, `${label}: the read says unreadable`);
    // An MCP tool asks by default (web_search and web_fetch default to allow, so they could not show it).
    assert.deepEqual(permissionFrom("mcp:srv/echo", read.settings, {}, "never"), { permission: "ask", from: "default" }, `${label}: the default ask is kept under never`);
    assert.equal(permissionFrom("web_fetch", read.settings, { web_fetch: { permission: "ask" } }, "never").permission, "ask", `${label}: the agent's own ask is kept under never`);
  }
  // No row is every default, not unreadable: never still lifts a clean ask there.
  assert.deepEqual(permissionFrom("mcp:srv/echo", storedSettings(undefined).settings, {}, "never"), { permission: "allow", from: "unattended" }, "no row: never lifts the default ask");
});
