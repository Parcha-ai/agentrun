// The tool gate reads the server's tool settings at each call (tool-gate.ts RunGate.policy), and fails closed on
// settings it cannot fully read: a bad entry is dropped and the good ones keep their meaning (a deny stays a deny),
// settings that stop reading keep the last good ones, and with none ever read every tool asks. The settings are the one
// store's, as the runner reads them (tool-plane.ts loadToolSettings).
import assert from "node:assert/strict";
import { test } from "node:test";
import { liveSettings, runnerGate, storedSettings } from "./gate-support.mjs";

/** A stored value that does not read as settings at all: what a write cut off would leave. */
const CUT = '{"bash":{"permission":"de';

test("an entry the gate cannot read is dropped and the others keep their meaning: a deny beside an unknown key stays a deny", () => {
  const stored = { bash: { permission: "deny" }, zzz: 1 };
  assert.equal(runnerGate({ settings: stored }).policy("bash"), "deny");
  assert.deepEqual(storedSettings(stored).settings, { bash: { permission: "deny" } }, "the server reads it so too");
});

test("a known tool's permission the gate does not offer reads ask, never allow", () => {
  assert.equal(runnerGate({ settings: { read: { permission: "maybe" } } }).policy("read"), "ask");
});

test("settings that stop reading keep the last good settings", () => {
  const live = liveSettings({ bash: { permission: "deny" }, read: { permission: "allow" } });
  const gate = runnerGate({ settings: live.read });
  assert.equal(gate.policy("bash"), "deny");
  live.set(CUT);
  assert.equal(gate.policy("bash"), "deny", "the last good deny");
  assert.equal(gate.policy("read"), "allow", "the last good allow");
});

test("settings that never read ask for every tool", () => {
  const gate = runnerGate({ settings: CUT });
  // The shell tools too, the watchers among them: an ask nothing read is never lifted to allow.
  for (const tool of ["read", "web_fetch", "bash", "bash_background", "bash_input", "bash_output", "bash_list", "bash_signal"]) assert.equal(gate.policy(tool), "ask", tool);
});
