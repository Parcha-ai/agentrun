// The gate's names, pinned: every name shape each harness emits (pi, claude-agent, codex, OpenCode; built-ins, hands,
// MCP, native search, shell, pi-browser, kind tools) maps to the settings key, asked-as name and permissions the table in
// tool-gate-key-pins.rows.mjs holds. It was written against the parse that settingsKeyOf was before it became a lookup in
// the session's name map, and passes on both.
import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsKeyOf } from "../dist/tool-gate.js";
import { runnerGate } from "./gate-support.mjs";
import { ROWS } from "./tool-gate-key-pins.rows.mjs";

const DENY = Object.fromEntries(["bash", "read", "browser", "desktop", "phone", "monid.run", "mcp:srv/echo", "web_search"].map((key) => [key, { permission: "deny" }]));
const split = (servers) => (servers === "" ? [] : servers.split(","));

test("the table covers every harness, each name, and the three server sets", () => {
  assert.equal(new Set(ROWS.map((row) => row[0])).size, 5);
  assert.equal(new Set(ROWS.map((row) => row[1])).size, 3);
  assert.ok(ROWS.length >= 1500);
});

test("settingsKeyOf and the gate's decisions are what the table pins, for every name on every harness", () => {
  const gates = new Map();
  const gateOf = (harness, servers, settings, tag) => {
    const id = `${harness}|${servers}|${tag}`;
    if (!gates.has(id)) gates.set(id, runnerGate({ harness, mcpServers: split(servers), settings }));
    return gates.get(id);
  };
  const bad = [];
  for (const [harness, servers, name, key, asked, open, shut] of ROWS) {
    const got = [settingsKeyOf(harness, name, split(servers)) ?? null, gateOf(harness, servers, {}, "open").askedAs(name), gateOf(harness, servers, {}, "open").policy(name), gateOf(harness, servers, DENY, "shut").policy(name)];
    if (JSON.stringify(got) !== JSON.stringify([key, asked, open, shut])) bad.push(`${harness} [${servers}] ${JSON.stringify(name)}: ${JSON.stringify(got)} != ${JSON.stringify([key, asked, open, shut])}`);
  }
  assert.deepEqual(bad, []);
});
