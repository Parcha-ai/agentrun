// A resumed OpenCode session's call that its gate held (parked) and that never started: the next process settles it
// through the kernel's tool bridge under the id the model gave it (the gate asked again, then its intent, the call and
// its result, all journaled), rewrites OpenCode's transcript with the result, and OpenCode starts again on it, so the
// model reads the call's result and goes on. On the OpenCode stand-in, its model scripted.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { openCodeAdapter } from "../dist/harness-opencode/index.js";
import { suiteTools } from "../dist/runner/conformance/harness.js";
import { hostTools, scriptedResponses } from "./conformance-opencode.mjs";

const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const until = async (done, what) => {
  for (let i = 0; i < 200; i++) {
    if (await done()) return;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`not seen: ${what}`);
};

test("a call the gate parked is settled through the bridge on resume, under its own id, and the model reads its result", async (t) => {
  const requests = [];
  const { tools, ran } = suiteTools();
  const sessionsDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-opencode-resume-"));
  const adapter = openCodeAdapter({
    model: "gpt-test",
    provider: { origin: "https://provider.invalid", credential: () => `not-a-secret-${"x"}` },
    price: () => 0,
    sessionsDir,
    standIn: { command: process.execPath, args: [STAND_IN] },
    // A real model's call ids: a call made again is a new call, under a new id.
    fetch: scriptedResponses([{ call: "effect", args: { n: 1 } }, { say: "done" }], requests, { callId: (step, n) => `call_${step}_r${n}` }),
  });
  const store = memorySessionStore();
  const spec = { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" };
  const models = { beforeRequest: async () => undefined, afterRequest: async () => undefined };
  const asked = [];

  // The first process: the gate parks the call; the run lets go of the session.
  const first = new AbortController();
  const parked = await adapter.open(spec, { writer: await store.open("root"), models, signal: first.signal, onEvent: () => {}, gate: async (call) => (asked.push(["park", call]), { park: true }) });
  await parked.send("Follow the script.");
  await until(() => asked.length === 1, "the gate asked about the call");
  first.abort(new Error("the run parked"));
  await parked.close();
  assert.equal(ran.effect, 0, "a parked call never ran");

  // The next process: approved, the call goes through the bridge under the model's id, then OpenCode goes on.
  const resumed = await adapter.open(spec, { writer: await store.open("root"), models, signal: new AbortController().signal, onEvent: () => {}, gate: async (call) => (asked.push(["allow", call]), "allow") });
  t.after(() => resumed.close());
  assert.equal(resumed.state, "open_turn");
  await resumed.recover();
  const end = await resumed.turnEnd();
  assert.equal(end.status, "completed");
  assert.equal(ran.effect, 1, "it ran once");
  assert.deepEqual(asked.map(([what, call]) => [what, call.callId, call.tool]), [["park", "call_0_r0", "effect"], ["allow", "call_0_r0", "effect"]], "asked again under the id the model gave it");
  const last = requests.at(-1).input;
  assert.deepEqual(last.filter((item) => item.type === "function_call").map((item) => item.call_id), ["call_0_r0"], "the model's call, once: never made again");
  assert.equal(last.find((item) => item.type === "function_call_output")?.output, "the effect happened", "the model reads the call's result");
});
