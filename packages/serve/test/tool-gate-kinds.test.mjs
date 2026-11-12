// A computer kind's tools at the tool gate (tool-gate.ts settingsKeyOf, tool-plane.ts): the computer's tools
// (computer_observe, computer_act, computer_screenshot, computer_script, the hand-over) are the desktop's and the phone's
// alike, held to the kind's settings key, as the browser's family is held to browser; the mapping is read from the kernel
// registry's own definitions (their settingsKey), on every harness's names for them. Allowed by default like the table's
// tools, so an observe never asks; an owner sets each key to allow or deny. The gate knows not the run's kind, so each is
// held to the stricter of the two keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPUTER_TOOLS, computerToolDefs } from "@parcha/agentrun-kernel/kernel";
import { deniedText, settingsKeyOf } from "../dist/tool-gate.js";
import { KIND_KEYS, permissionsOf, settingsIssues } from "../dist/tool-plane.js";
import { runnerGate } from "./gate-support.mjs";

test("the computer's tools are the desktop's and the phone's, each under its kind's key, by every harness's name for it", () => {
  assert.deepEqual([...KIND_KEYS], ["desktop", "phone"]);
  assert.deepEqual(computerToolDefs("desktop", []).map((def) => [def.name, def.settingsKey]), COMPUTER_TOOLS.map((name) => [name, "desktop"]));
  assert.deepEqual(computerToolDefs("phone", []).map((def) => [def.name, def.settingsKey]), COMPUTER_TOOLS.map((name) => [name, "phone"]));
  for (const name of COMPUTER_TOOLS) {
    for (const harness of ["pi", "claude-agent", "codex", "opencode"]) {
      assert.equal(settingsKeyOf(harness, name), "desktop", `${harness} ${name}: named by the desktop's key in words`);
      assert.equal(settingsKeyOf(harness, `mcp__hands__${name}`), "desktop", `${harness} mcp__hands__${name}`);
    }
  }
});

test("the kind keys are allow or deny, allowed by default; a settings map may name them", () => {
  for (const key of KIND_KEYS) assert.deepEqual(permissionsOf(key), ["allow", "deny"], key);
  assert.deepEqual(settingsIssues({ desktop: { permission: "deny" }, phone: { permission: "allow" } }), []);
  assert.deepEqual(settingsIssues({ desktop: { permission: "ask" } }).map((issue) => [issue.field, issue.reason]), [["desktop.permission", "not_an_option"]]);
  const gate = runnerGate();
  assert.equal(gate.policy("computer_observe"), "allow", "an observe never asks");
  assert.equal(gate.policy("computer_act"), "allow");
});

test("desktop set to deny refuses every computer tool at the gate, before it runs", async () => {
  const gate = runnerGate({ settings: { desktop: { permission: "deny" } } });
  for (const name of COMPUTER_TOOLS) assert.deepEqual(await gate.decide(name, {}), { deny: deniedText("desktop", "desktop", "server", "no") }, name);
});

test("each computer tool is held to the stricter of desktop and phone: either set to deny refuses it", () => {
  const gateWith = (settings) => runnerGate({ settings });
  for (const name of COMPUTER_TOOLS) {
    assert.equal(gateWith({}).policy(name), "allow", `${name}: both allowed by default`);
    assert.equal(gateWith({ desktop: { permission: "deny" } }).policy(name), "deny", name);
    assert.equal(gateWith({ phone: { permission: "deny" } }).policy(name), "deny", name);
  }
});
