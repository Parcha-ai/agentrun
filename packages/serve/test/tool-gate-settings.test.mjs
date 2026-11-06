// The tool gate reads the server's tool settings at each call (tool-gate.ts RunGate.policy), and fails closed on a
// settings file it cannot fully read: a bad entry is dropped and the good ones keep their meaning (a deny stays a deny),
// a file that does not read keeps the last good settings, and with none ever read every tool asks.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { RunGate } from "../dist/tool-gate.js";
import { ToolSettings } from "../dist/tool-plane.js";
import { scratch } from "./support.mjs";

async function gateOn(t, text) {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  const write = (body) => writeFile(join(data, "tool-settings.json"), body);
  if (text !== undefined) await write(text);
  return { gate: new RunGate({ root, work, data, runId: "r1" }), write, data };
}

test("an entry the gate cannot read is dropped and the others keep their meaning: a deny beside an unknown key stays a deny", async (t) => {
  const { gate, data } = await gateOn(t, JSON.stringify({ bash: { permission: "deny" }, zzz: 1 }));
  assert.equal(gate.policy("bash"), "deny");
  assert.deepEqual(new ToolSettings(data, () => undefined).get(), { bash: { permission: "deny" } }, "the server reads it so too");
});

test("a known tool's permission the gate does not offer reads ask, never allow", async (t) => {
  const { gate } = await gateOn(t, JSON.stringify({ read: { permission: "maybe" } }));
  assert.equal(gate.policy("read"), "ask");
});

test("a settings file that stops reading (cut off mid-write) keeps the last good settings", async (t) => {
  const { gate, write } = await gateOn(t, JSON.stringify({ bash: { permission: "deny" }, read: { permission: "allow" } }));
  assert.equal(gate.policy("bash"), "deny");
  await write('{"bash":{"permission":"de');
  assert.equal(gate.policy("bash"), "deny", "the last good deny");
  assert.equal(gate.policy("read"), "allow", "the last good allow");
});

test("a settings file that never read asks for every tool", async (t) => {
  const { gate } = await gateOn(t, '{"bash":{"permission":"de');
  // The shell tools too, the watchers among them: an ask nothing read is never lifted to allow.
  for (const tool of ["read", "web_fetch", "bash", "bash_background", "bash_input", "bash_output", "bash_list", "bash_signal"]) assert.equal(gate.policy(tool), "ask", tool);
});
