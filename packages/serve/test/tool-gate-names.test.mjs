// The names a call reaches the gate by, and the settings key each one is held to (tool-gate.ts settingsKeyOf): one
// mapping for every harness. pi calls a tool by its registration's name (monid's wire names, the browser's run,
// snapshot and the rest); claude-agent and codex call the host tools by their catalog names; a CLI's own tools and an
// MCP server's tools have names of their own. Every one of them maps to a settings key, and a name nothing maps fails
// closed: ask, never allow.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BROWSER_TOOL_NAMES } from "@parcha/pi-browser";
import { wireName } from "../dist/catalog.js";
import { BACKGROUND_TOOLS } from "../dist/background.js";
import { REPLAY } from "../dist/host-tools.js";
import * as gate from "../dist/tool-gate.js";
import { permissionsOf, SERVE_OWN_TOOLS, TABLE_TOOLS } from "../dist/tool-plane.js";
import { scratch } from "./support.mjs";

const { deniedText, noApproverText, RunGate, waitingText } = gate;
/** The mapping, where the module has one; none (the red), every name maps to nothing. */
const keyOf = (harness, name, servers) => (typeof gate.settingsKeyOf === "function" ? gate.settingsKeyOf(harness, name, servers) : undefined);
const isKey = (key) => typeof key === "string" && (TABLE_TOOLS.includes(key) || SERVE_OWN_TOOLS.includes(key) || /^monid\.[a-z]+$/.test(key) || /^mcp:[a-z][a-z0-9-]*\/.+$/.test(key));
const MONID = ["monid.discover", "monid.inspect", "monid.run"];
/** A host tool's settings key: its own name, or for a legacy name the capability the tool plane folds it into; a
 *  background tool (background.ts) is held to bash's. */
const folded = (name) => (BACKGROUND_TOOLS.includes(name) ? "bash" : name);

/** Every name a call reaches the gate by, on each harness, and the key it must map to. */
const NAMES = {
  pi: [
    ...["read", "write", "edit", "bash", "ask_person", "web_fetch", "web_search"].map((name) => [name, name]),
    ...BACKGROUND_TOOLS.map((name) => [name, "bash"]),
    ...MONID.map((name) => [wireName(name), name]),
    ...BROWSER_TOOL_NAMES.map((name) => [name, "browser"]),
    ["mcp__srv__echo", "mcp:srv/echo"],
  ],
  "claude-agent": [
    ...Object.keys(REPLAY).flatMap((name) => [[name, folded(name)], [wireName(name), folded(name)], [`mcp__hands__${wireName(name)}`, folded(name)]]),
    ["WebSearch", "web_search"], ["WebFetch", "web_fetch"], ["Bash", "bash"],
    ["mcp__srv__echo", "mcp:srv/echo"],
  ],
  codex: [
    ...Object.keys(REPLAY).flatMap((name) => [[name, folded(name)], [wireName(name), folded(name)]]),
    ["web_search", "web_search"], ["shell", "bash"],
    // The adapter's own read of a skill's file, from the session's copy of the run's skills: read's key.
    ["read_skill_file", "read"],
    ["mcp__srv__echo", "mcp:srv/echo"],
  ],
  opencode: [["read_skill_file", "read"], ["mcp__srv__echo", "mcp:srv/echo"]],
};

test("every name a call reaches the gate by, on every harness, maps to its settings key", () => {
  for (const [harness, names] of Object.entries(NAMES)) {
    for (const [name, key] of names) {
      const got = keyOf(harness, name);
      assert.ok(isKey(got), `${harness} ${name}: ${got}`);
      assert.equal(got, key, `${harness} ${name}`);
    }
  }
});

test("a name nothing maps fails closed: it asks, and where no one can approve it is refused", async (t) => {
  assert.equal(keyOf("pi", "mystery_tool"), undefined);
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  const where = { root, work, data, runId: "r1" };
  assert.equal(new RunGate(where).policy("mystery_tool"), "ask", "never allow");
  const park = { commit: async (change) => change({ appendEntry: async () => undefined }) };
  assert.deepEqual(await new RunGate(where, {}, true, false).enter("mystery_tool", {}, "c1", park), { text: noApproverText("mystery_tool"), isError: true });
});

/** A run's gate on `harness`, its server settings `settings` (none: the default), and its answer for one call as the
 *  runner's loops ask it (RunGate.decide, the adapter loop's spec.gate): "allow" (it runs), "ask" (it waits for a person,
 *  under the name askedAs gives) or { deny } (refused, in those words). */
async function decideOn(t, harness, settings, name, args, mcpServers) {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  if (settings) await writeFile(join(data, "tool-settings.json"), JSON.stringify(settings));
  const runGate = new RunGate({ root, work, data, runId: "r1", harness, ...(mcpServers ? { mcpServers } : {}) });
  return { decided: await runGate.decide(name, args), askedAs: runGate.askedAs(name), policy: runGate.policy(name) };
}
const SKILL_READ = { skill: "status-report-format", path: "SKILL.md" };

test("read_skill_file, codex's and OpenCode's own read of a skill's file, is held to read's key: the default runs it, never asked", async (t) => {
  for (const harness of ["codex", "opencode"]) {
    const { decided, policy } = await decideOn(t, harness, undefined, "read_skill_file", SKILL_READ);
    assert.equal(policy, "allow", `${harness}: allowed, as read is`);
    assert.equal(decided, "allow", `${harness}: it runs, with no approval asked`);
  }
});

test("read_skill_file is refused when the server denies read, in the deny words naming read's setting", async (t) => {
  for (const harness of ["codex", "opencode"]) {
    const { decided, policy } = await decideOn(t, harness, { read: { permission: "deny" } }, "read_skill_file", SKILL_READ);
    assert.equal(policy, "deny", harness);
    assert.deepEqual(decided, { deny: deniedText("read") }, harness);
  }
});

test("on OpenCode, an agent's MCP tool whose wire name is read_skill_file (server read, tool skill_file) keeps its own key and setting: never read's", async (t) => {
  assert.equal(keyOf("opencode", "read_skill_file", ["read"]), "mcp:read/skill_file", "the run's MCP server named read owns the name");
  assert.equal(keyOf("opencode", "read_skill_file", ["other"]), "read", "another server's: the adapter's own read of a skill's file");
  assert.equal(keyOf("codex", "read_skill_file", ["read"]), "read", "codex names no MCP tool <server>_<tool>");
  assert.equal(keyOf("codex", "mcp__hands__read_skill_file", ["read"]), "read", "hands is the host's own server, never an agent's");
  // Set to ask, as an MCP tool's default is: it waits for a person's approval, asked under its own key, never run as read.
  const { decided, askedAs, policy } = await decideOn(t, "opencode", { "mcp:read/skill_file": { permission: "ask" } }, "read_skill_file", { q: 1 }, ["read"]);
  assert.equal(policy, "ask");
  assert.equal(decided, "ask", "it does not run: it waits for a person");
  assert.equal(askedAs, "mcp:read/skill_file", "asked under its own key");
});

test("the key only: read_skill_file's own path is no read path to the gate, so one that looks like it leaves the work folder is not refused here (the skill reader's own bounds are its own)", async (t) => {
  for (const harness of ["codex", "opencode"]) {
    for (const path of ["../x/SKILL.md", "/etc/passwd"]) {
      const { decided } = await decideOn(t, harness, undefined, "read_skill_file", { skill: "status-report-format", path });
      assert.equal(decided, "allow", `${harness} ${path}: the gate lets it through to the reader`);
    }
  }
});

/** pi's registration `name`, wrapped by a run's gate on `data`'s settings: what its call answers, whether the tool ran,
 *  and the requests the gate kept. */
async function onPi(t, settings, name) {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  if (settings) await writeFile(join(data, "tool-settings.json"), JSON.stringify(settings));
  const runGate = new RunGate({ root, work, data, runId: "r1", harness: "pi" });
  let ran = 0;
  const registration = { name, description: name, parameters: {}, execute: async () => (ran++, { content: [{ type: "text", text: "ran" }] }) };
  const extension = runGate.extension([registration]);
  const wrapped = extension.wraps.find((wrap) => wrap.tool === name)?.wrap(registration) ?? registration;
  const kept = [];
  const api = { callId: `c-${name}`, commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const result = await wrapped.execute({ q: 1 }, api, {});
  const text = (result.content ?? result.output ?? []).map((block) => block.text ?? "").join("");
  return { text, isError: result.isError === true, ran, kept };
}

test("on pi, monid.run set to deny refuses monid's registration, monid_run, by its settings key", async (t) => {
  const { text, ran } = await onPi(t, { "monid.run": { permission: "deny" } }, wireName("monid.run"));
  assert.deepEqual([text, ran], [deniedText("monid.run"), 0]);
});

test("on pi, monid.run at its default asks: monid_run parks, and its request names the settings key", async (t) => {
  const { text, ran, kept } = await onPi(t, undefined, wireName("monid.run"));
  assert.deepEqual([text, ran], [waitingText("monid.run"), 0]);
  assert.deepEqual(kept.map((entry) => entry.data?.tool), ["monid.run"]);
});

test("on pi, browser set to deny refuses each of its registrations, run and snapshot among them", async (t) => {
  for (const name of ["run", "snapshot"]) {
    const { text, ran } = await onPi(t, { browser: { permission: "deny" } }, name);
    assert.deepEqual([text, ran], [deniedText("browser"), 0], name);
  }
});

test("on pi, the agent's ask for the person in its browser (browser_request_handoff) is held to the browser setting: deny refuses it, allow lets it run (the browser offers no ask)", async (t) => {
  assert.ok(BROWSER_TOOL_NAMES.includes("browser_request_handoff"), "pi-browser lists it");
  assert.equal(keyOf("pi", "browser_request_handoff"), "browser");
  const denied = await onPi(t, { browser: { permission: "deny" } }, "browser_request_handoff");
  assert.deepEqual([denied.text, denied.ran], [deniedText("browser"), 0], "deny: refused, never asked of the person");
  const allowed = await onPi(t, { browser: { permission: "allow" } }, "browser_request_handoff");
  assert.deepEqual([allowed.text, allowed.ran], ["ran", 1], "allow: it runs");
  assert.deepEqual(permissionsOf("browser"), ["allow", "deny"], "the browser setting is allow or deny");
});

test("OpenCode's <server>_<tool> is an MCP tool only for a server the run has configured, never by its shape alone; a table tool's name stays the table tool's", () => {
  assert.equal(keyOf("opencode", "srv_echo", ["srv"]), "mcp:srv/echo");
  assert.equal(keyOf("opencode", "srv_echo"), undefined, "no server configured: unmapped, so it asks");
  assert.equal(keyOf("opencode", "srv_echo", ["other"]), undefined, "another server's name");
  assert.equal(keyOf("opencode", "web_fetch", ["web"]), "web_fetch", "a table tool, though `web` is a server");
  assert.equal(keyOf("opencode", "ask_person", ["ask"]), "ask_person");
});

test("an MCP call enters this gate once on every harness: the host tools bind none, and pi's extension skips only a registration the MCP gateway marks as gated by itself", async (t) => {
  const { hostTools } = await import("../dist/host-tools.js");
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  const runGate = new RunGate({ root, work, data, runId: "r1", harness: "claude-agent" });
  let entered = 0;
  runGate.enter = async () => void entered++;
  const park = { commit: async () => undefined };
  // claude-agent and codex: the host tools bind no MCP tool, by any of its names.
  const bound = hostTools({}, ["mcp:srv/echo", "mcp__srv__echo", "srv_echo"], {}, new Map(), [], { gate: runGate, park });
  assert.deepEqual(bound.map((tool) => tool.name), []);
  // pi: a registration the gateway marks (it enters the gate itself) is not wrapped again; an unmarked one is wrapped.
  const registration = { name: "mcp__srv__echo", description: "", parameters: {}, execute: async () => ({ content: [] }) };
  assert.deepEqual(runGate.extension([{ ...registration, [gate.GATED_BY_GATEWAY]: true }]).wraps, [], "the gateway's own: gated there");
  assert.deepEqual(runGate.extension([registration]).wraps.map((wrap) => wrap.tool), ["mcp__srv__echo"], "unmarked: wrapped here");
  assert.equal(entered, 0);
});
