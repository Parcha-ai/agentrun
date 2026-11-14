// The tool table's decisions for the names that matter, hand-written: what each is permitted, defaulted, keyed and
// replayed as. Folding or changing tool-list.ts shows as a diff here. The default is "a built-in of the table allows,
// anything else asks": a name nothing registers asks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostToolOf } from "../dist/host-tools.js";
import { permissionsOf } from "../dist/tool-plane.js";
import { defaultPermission, settingsKeyOf } from "../dist/tool-gate.js";
import { blurbOf, isHostTool, tableTools } from "../dist/tool-list.js";

const REG = { name: "x", description: "x", parameters: {} };
// name: [permissions, default (computer, no computer), pi's settings key, replay]
const PINNED = {
  read: [["allow", "ask", "deny"], ["allow", "allow"], "read", "safe"],
  bash: [["allow", "ask", "deny"], ["allow", "ask"], "bash", "never"],
  ask_person: [["allow", "deny"], ["allow", "allow"], "ask_person", "safe"],
  browser: [["allow", "deny"], ["allow", "allow"], "browser", undefined],
  bash_background: [["allow", "ask", "deny"], ["allow", "deny"], "bash", "never"],
  bash_output: [["allow", "ask", "deny"], ["allow", "deny"], "bash", "safe"],
  learned_workflow: [["allow", "ask", "deny"], ["allow", "allow"], "learned_workflow", "never"],
  "monid.run": [["allow", "ask", "deny"], ["ask", "ask"], "monid.run", "never"],
  "mcp:linear/create_issue": [["allow", "ask", "deny"], ["ask", "ask"], "mcp:linear/create_issue", undefined],
  frobnicate: [["allow", "deny"], ["ask", "ask"], undefined, undefined],
};

test("each pinned name is permitted, defaulted, keyed and replayed as written", () => {
  for (const [name, [permissions, defaults, key, replay]] of Object.entries(PINNED)) {
    assert.deepEqual([...permissionsOf(name)], permissions, `${name} permissions`);
    assert.deepEqual([defaultPermission(name), defaultPermission(name, { computer: false })], defaults, `${name} default`);
    assert.equal(settingsKeyOf("pi", name), key, `${name} key`);
    assert.equal(hostToolOf(name, REG, {})?.replay, replay, `${name} replay`);
  }
});

test("the table's names are these, in this order", () => {
  assert.deepEqual(tableTools(), ["read", "write", "edit", "bash", "ask_person", "web_fetch", "web_search", "browser", "subagent", "pdf_pages", "llm"]);
  assert.equal(blurbOf("web_search"), "Search the web");
  assert.equal(isHostTool("web_search") && isHostTool("monid.run") && !isHostTool("browser"), true);
});

test("a name no table registers asks by default: the gate defaults to ask for anything but a built-in", () => {
  for (const name of ["frobnicate", "toString", "constructor", "", "mcp__hands__read"]) assert.equal(defaultPermission(name), "ask", name);
  assert.equal(defaultPermission("jev"), "allow");
  assert.equal(defaultPermission("desktop"), "allow");
});
