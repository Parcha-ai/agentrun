// A computer kind's tools at the tool gate (tool-gate.ts settingsKeyOf, tool-plane.ts): the computer's tools
// (computer_observe, computer_act, computer_screenshot, computer_op, the hand-over) are the desktop's and the phone's
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
      assert.equal(settingsKeyOf(harness, name), "desktop", `${harness} ${name}: named by the desktop's key in words`);    }
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

test("a script's shell, write and read are decided as the run's own bash, write and read are, on every harness: a deny, a read-only policy, and the default", async () => {
  for (const harness of ["pi", "claude-agent", "codex", "opencode"]) {
    const denied = runnerGate({ harness, settings: { bash: { permission: "deny" }, write: { permission: "deny" }, read: { permission: "deny" } } });
    for (const [tool, args] of [["bash", { command: "ls" }], ["write", { path: "/workspace/a" }], ["read", { path: "/workspace/a" }]]) {
      const decided = await denied.decide(tool, args);
      assert.ok(typeof decided === "object" && "deny" in decided, `${harness} ${tool} is refused`);
    }
    assert.equal(await runnerGate({ harness }).decide("bash", { command: "ls" }), "allow", `${harness}: the default allows`);
  }
  const readOnly = runnerGate({ overrides: { bash: { policy: "read-only" } } });
  assert.equal(await readOnly.decide("bash", { command: "ls" }), "allow");
  const refused = await readOnly.decide("bash", { command: "rm -rf /workspace/x" });
  assert.ok(typeof refused === "object" && "deny" in refused, "a read-only policy refuses a command that writes");
});

// A codemode script's `computer` reaches its shell and its files through computer_op: each op is held to the run's own
// tool's setting (bash, write, read), on every harness, and to the kind's deny first.
const op = (name, args) => ["computer_op", { op: name, args }];
test("a script's computer_op is decided as the run's own bash, write and read are, on every harness: a deny, a read-only policy, the default, and the kind's deny first", async () => {
  const held = [op("shell.run", { command: "ls" }), op("processes.start", { command: ["sleep", "1"] }), op("files.write", { path: "/workspace/a", data: "x" }), op("files.read", { path: "/workspace/a" }), op("files.list", { path: "/workspace" }), op("files.stat", { path: "/workspace/a" })];
  for (const harness of ["pi", "claude-agent", "codex", "opencode"]) {
    const denied = runnerGate({ harness, settings: { bash: { permission: "deny" }, write: { permission: "deny" }, read: { permission: "deny" } } });
    for (const [tool, args] of held) {
      const decided = await denied.decide(tool, args);
      assert.ok(typeof decided === "object" && "deny" in decided, `${harness} ${args.op} is refused: ${JSON.stringify(decided)}`);
    }
    // An op no tool of the run's runs (the apps, raw input) is the kind's alone.
    assert.equal(await denied.decide(...op("apps.list", {})), "allow", `${harness}: apps.list is the kind's`);
    for (const [tool, args] of held) assert.equal(await runnerGate({ harness }).decide(tool, args), "allow", `${harness} ${args.op}: the default allows`);
  }
  const readOnly = runnerGate({ overrides: { bash: { policy: "read-only" } } });
  assert.equal(await readOnly.decide(...op("shell.run", { command: "ls" })), "allow");
  const refused = await readOnly.decide(...op("shell.run", { command: "rm -rf /workspace/x" }));
  assert.ok(typeof refused === "object" && "deny" in refused && /bash/.test(refused.deny), `a read-only policy refuses a script's command that writes, in bash's words: ${JSON.stringify(refused)}`);
  const kindDenied = runnerGate({ settings: { desktop: { permission: "deny" } } });
  for (const [tool, args] of held) assert.deepEqual(await kindDenied.decide(tool, args), { deny: deniedText("desktop", "desktop", "server", "no") }, `desktop set to deny refuses ${args.op} in its words, bash allowed or not`);
});
