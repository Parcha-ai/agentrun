// A computer kind's tools at the tool gate (tool-gate.ts settingsKeyOf, tool-plane.ts): each desktop tool is held to
// one settings key, desktop, and each phone tool to phone, as the browser's family is held to browser; the mapping is
// read from the kernel registry's own definitions (their settingsKey), on every harness's names for them. Allowed by
// default like the table's tools, so a screenshot never asks; an owner sets each key to allow or deny.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_TOOL_DEFS, PHONE_TOOL_DEFS } from "@parcha/agentrun-kernel/kernel";
import { deniedText, settingsKeyOf } from "../dist/tool-gate.js";
import { KIND_KEYS, permissionsOf, settingsIssues } from "../dist/tool-plane.js";
import { runnerGate } from "./gate-support.mjs";

/** The hand-over both kinds have: held to the stricter of the two keys (the gate does not know the run's kind), named by
 *  the desktop's in words. */
const SHARED = "computer_request_handoff";
const KINDS = [...DESKTOP_TOOL_DEFS.map((def) => [def.name, "desktop"]), ...PHONE_TOOL_DEFS.filter((def) => def.name !== SHARED).map((def) => [def.name, "phone"])];

test("each desktop tool is held to desktop and each phone tool to phone, by every harness's name for it", () => {
  assert.deepEqual([...KIND_KEYS], ["desktop", "phone"]);
  assert.ok(KINDS.some(([name]) => name === SHARED), "the hand-over is a kind tool");
  assert.ok(KINDS.some(([name]) => name === "phone_tree") && KINDS.some(([name]) => name === "phone_key"), "the phone's tree and keys are kind tools");
  for (const [name, key] of KINDS) {
    for (const harness of ["pi", "claude-agent", "codex", "opencode"]) {
      assert.equal(settingsKeyOf(harness, name), key, `${harness} ${name}`);
      assert.equal(settingsKeyOf(harness, `mcp__hands__${name}`), key, `${harness} mcp__hands__${name}`);
    }
  }
});

test("the kind keys are allow or deny, allowed by default; a settings map may name them", () => {
  for (const key of KIND_KEYS) assert.deepEqual(permissionsOf(key), ["allow", "deny"], key);
  assert.deepEqual(settingsIssues({ desktop: { permission: "deny" }, phone: { permission: "allow" } }), []);
  assert.deepEqual(settingsIssues({ desktop: { permission: "ask" } }).map((issue) => [issue.field, issue.reason]), [["desktop.permission", "not_an_option"]]);
  const gate = runnerGate();
  assert.equal(gate.policy("desktop_screen"), "allow", "a screenshot never asks");
  assert.equal(gate.policy("phone_tap"), "allow");
});

test("desktop set to deny refuses every desktop tool at the gate, and phone to deny every phone tool, before it runs", async () => {
  const gate = runnerGate({ settings: { desktop: { permission: "deny" }, phone: { permission: "deny" } } });
  for (const [name, key] of KINDS) {
    assert.deepEqual(await gate.decide(name, {}), { deny: deniedText(key, key, "server", "no") }, name);
  }
});

test("the hand-over both kinds share is held to the stricter of desktop and phone: either set to deny refuses it", () => {
  const gateWith = (settings) => runnerGate({ settings });
  assert.equal(gateWith({}).policy(SHARED), "allow", "both allowed by default");
  assert.equal(gateWith({ desktop: { permission: "deny" } }).policy(SHARED), "deny");
  assert.equal(gateWith({ phone: { permission: "deny" } }).policy(SHARED), "deny");
});
