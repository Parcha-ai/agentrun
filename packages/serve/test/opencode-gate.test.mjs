// OpenCode's calls meet the host's gate (SessionIO.gate) on the kernel's tool bridge, before anything of the call is
// written: the gate is asked with the model's own call id, the host's tool name and the arguments; a deny answers the
// model in the host's words, and the tool never runs; an allow runs it. On the OpenCode stand-in, its model scripted.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { openCodeAdapter } from "../dist/harness-opencode/index.js";
import { hostTools, scriptedResponses } from "./conformance-opencode.mjs";
import { suiteTools } from "../dist/runner/conformance/harness.js";
import { fileURLToPath } from "node:url";

const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));

async function turn(t, gate) {
  const requests = [];
  const { tools, ran } = suiteTools();
  const adapter = openCodeAdapter({
    model: "gpt-test",
    provider: { origin: "https://provider.invalid", credential: () => `not-a-secret-${"x"}` },
    price: () => 0,
    sessionsDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-opencode-gate-")),
    standIn: { command: process.execPath, args: [STAND_IN] },
    fetch: scriptedResponses([{ call: "effect", args: { n: 1 } }, { say: "done" }], requests),
  });
  const writer = await memorySessionStore().open("root");
  const asked = [];
  const io = { writer, models: { beforeRequest: async () => undefined, afterRequest: async () => undefined }, signal: new AbortController().signal, onEvent: () => {}, gate: async (call) => (asked.push(call), gate(call)) };
  const session = await adapter.open({ key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" }, io);
  t.after(() => session.close());
  await session.send("Follow the script.");
  const end = await session.turnEnd();
  const output = requests.at(-1).input.find((item) => item.type === "function_call_output")?.output;
  return { end, ran, asked, output };
}

test("a deny answers the model in the host's words, and the tool never runs", async (t) => {
  const { end, ran, asked, output } = await turn(t, async () => ({ deny: "Permission denied: effect is set to deny." }));
  assert.deepEqual(asked, [{ callId: "call_0", tool: "effect", args: { n: 1 } }], "asked once, by the model's call id and the host's tool name");
  assert.equal(ran.effect, 0);
  assert.equal(output, "Permission denied: effect is set to deny.");
  assert.equal(end.status, "completed");
});

test("an allow runs the call", async (t) => {
  const { ran, asked, output } = await turn(t, async () => "allow");
  assert.equal(asked.length, 1);
  assert.equal(ran.effect, 1);
  assert.equal(output, "the effect happened");
});
