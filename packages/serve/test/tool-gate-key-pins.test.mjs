// The gate's names pinned: one row per name shape per harness, hitting every source of a session's name map and every
// open family settingsKeyOf still parses. [harness, mcp servers, name, settings key, permission, permission under denies]
import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsKeyOf } from "../dist/tool-gate.js";
import { runnerGate } from "./gate-support.mjs";

const DENY = Object.fromEntries(["bash", "read", "browser", "desktop", "monid.run", "mcp:srv/echo", "web_search"].map((key) => [key, { permission: "deny" }]));
const ROWS = [
  // table, own and decision tools: themselves
  ["pi", [], "read", "read", "allow", "deny"],
  ["pi", [], "web_search", "web_search", "allow", "deny"],
  ["pi", [], "learned_workflow", "learned_workflow", "allow", "allow"],
  ["pi", [], "jev", "jev", "allow", "allow"],
  // the shell family: bash's key
  ["pi", [], "bash_background", "bash", "allow", "deny"],
  ["claude-agent", [], "mcp__hands__bash_output", "bash", "allow", "deny"],
  // pi-browser's registrations: browser
  ["pi", [], "snapshot", "browser", "allow", "deny"],
  ["claude-agent", [], "mcp__hands__browser_read", "browser", "allow", "deny"],
  // a computer kind's tools: the kind's key, a shared one the first's
  ["claude-agent", [], "computer_screenshot", "desktop", "allow", "deny"],
  ["claude-agent", [], "mcp__hands__computer_act", "desktop", "allow", "deny"],
  ["claude-agent", [], "computer_request_handoff", "desktop", "allow", "deny"],
  // a CLI's own tools (nativeTools)
  ["claude-agent", [], "Bash", "bash", "allow", "deny"],
  ["claude-agent", [], "WebSearch", "web_search", "allow", "deny"],
  ["codex", [], "shell", "bash", "allow", "deny"],
  ["codex", [], "web_search", "web_search", "allow", "deny"],
  ["pi", [], "Bash", undefined, "ask", "ask"],
  // read_skill_file: read, unless OpenCode's alias makes it a configured server's tool
  ["codex", [], "read_skill_file", "read", "allow", "deny"],
  ["opencode", [], "read_skill_file", "read", "allow", "deny"],
  ["opencode", ["read"], "read_skill_file", "mcp:read/skill_file", "ask", "ask"],
  ["claude-agent", ["read"], "mcp__hands__read_skill_file", "read", "allow", "deny"],
  // the open families: catalog names, MCP aliases, monid wire names, OpenCode's alias for a configured server only
  ["pi", [], "monid.run", "monid.run", "ask", "deny"],
  ["pi", [], "monid_run", "monid.run", "ask", "deny"],
  ["claude-agent", [], "mcp__hands__monid_run", "monid.run", "ask", "deny"],
  ["pi", [], "mcp:srv/echo", "mcp:srv/echo", "ask", "deny"],
  ["pi", [], "mcp__srv__echo", "mcp:srv/echo", "ask", "deny"],
  ["claude-agent", [], "mcp__hands__mcp__srv__echo", "mcp:srv/echo", "ask", "deny"],
  ["opencode", ["srv"], "srv_echo", "mcp:srv/echo", "ask", "deny"],
  ["opencode", [], "srv_echo", undefined, "ask", "ask"],
  ["opencode", ["srv"], "srv_bash", "mcp:srv/bash", "ask", "ask"],
  // nothing maps it: asks
  ["pi", [], "mystery_tool", undefined, "ask", "ask"],
  ["claude-agent", [], "mcp__hands__mystery", undefined, "ask", "ask"],
];

test("each name shape maps to the settings key and permission pinned, on every harness", () => {
  for (const [harness, servers, name, key, open, shut] of ROWS) {
    assert.equal(settingsKeyOf(harness, name, servers), key, `${harness} ${name}`);
    assert.equal(runnerGate({ harness, mcpServers: servers, settings: {} }).policy(name), open, `${harness} ${name} (open)`);
    assert.equal(runnerGate({ harness, mcpServers: servers, settings: DENY }).policy(name), shut, `${harness} ${name} (deny)`);
  }
});
