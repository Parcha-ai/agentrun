// The gate's names pinned: one row per name shape per harness, hitting every source of a session's name map and every
// open family settingsKeyOf still parses. The gate is asked a host name (an adapter strips its harness's own prefix, and the
// loop reads a wire name back to its catalog name) so no prefixed form is here. [harness, name, settings key, permission,
// permission under denies]
import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsKeyOf } from "../dist/tool-gate.js";
import { runnerGate } from "./gate-support.mjs";

const DENY = Object.fromEntries(["bash", "read", "browser", "desktop", "monid:faux/*", "mcp:srv/echo", "web_search"].map((key) => [key, { permission: "deny" }]));
const ROWS = [
  // table, own and decision tools: themselves
  ["pi", "read", "read", "allow", "deny"],
  ["pi", "web_search", "web_search", "allow", "deny"],
  ["pi", "learned_workflow", "learned_workflow", "allow", "allow"],
  ["pi", "jev", "jev", "allow", "allow"],
  // the shell family: bash's key
  ["pi", "bash_background", "bash", "allow", "deny"],
  ["claude-agent", "bash_output", "bash", "allow", "deny"],
  // pi-browser's registrations: browser
  ["pi", "snapshot", "browser", "allow", "deny"],
  ["claude-agent", "browser_read", "browser", "allow", "deny"],
  // a computer kind's tools: the kind's key, a shared one the first's
  ["claude-agent", "computer_screenshot", "desktop", "allow", "deny"],
  ["claude-agent", "computer_act", "desktop", "allow", "deny"],
  ["claude-agent", "computer_request_handoff", "desktop", "allow", "deny"],
  // a CLI's own tools (nativeTools)
  ["claude-agent", "Bash", "bash", "allow", "deny"],
  ["claude-agent", "WebSearch", "web_search", "allow", "deny"],
  ["codex", "shell", "bash", "allow", "deny"],
  ["codex", "web_search", "web_search", "allow", "deny"],
  ["pi", "Bash", undefined, "ask", "ask"],
  // read_skill_file: read
  ["codex", "read_skill_file", "read", "allow", "deny"],
  ["opencode", "read_skill_file", "read", "allow", "deny"],
  // the open families: catalog names (a monid endpoint's denied by its provider's wildcard). A wire name is read back to
  // its catalog name by the loop (its ClaimMcp.catalogOf) before the gate is asked: alone, it is no name the gate maps,
  // and asks.
  ["pi", "monid:faux/person/enrich", "monid:faux/person/enrich", "ask", "deny"],
  ["claude-agent", "monid:faux/person/enrich", "monid:faux/person/enrich", "ask", "deny"],
  ["pi", "monid__faux__person__enrich", undefined, "ask", "ask"],
  ["pi", "mcp:srv/echo", "mcp:srv/echo", "ask", "deny"],
  ["pi", "mcp__srv__echo", undefined, "ask", "ask"],
  ["opencode", "srv_echo", undefined, "ask", "ask"],
  // nothing maps it: asks
  ["pi", "mystery_tool", undefined, "ask", "ask"],
  ["claude-agent", "mystery", undefined, "ask", "ask"],
];

test("each name shape maps to the settings key and permission pinned, on every harness", () => {
  for (const [harness, name, key, open, shut] of ROWS) {
    assert.equal(settingsKeyOf(harness, name), key, `${harness} ${name}`);
    assert.equal(runnerGate({ harness, settings: {} }).policy(name), open, `${harness} ${name} (open)`);
    assert.equal(runnerGate({ harness, settings: DENY }).policy(name), shut, `${harness} ${name} (deny)`);
  }
});
