// An OpenCode answer cut at the model's output limit: OpenCode records the answer's finish as "length" (the Responses
// stream ends `response.incomplete`, its reason max_output_tokens), and the adapter's turn_end says so, with the answer's
// output tokens, so the run's record can end the run failed in words rather than ended. A whole answer says nothing of
// the kind. On the OpenCode stand-in, its model scripted.
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

async function turnEndOf(t, script) {
  const { tools } = suiteTools();
  const adapter = openCodeAdapter({
    model: "gpt-test",
    provider: { origin: "https://provider.invalid", credential: () => `not-a-secret-${"x"}` },
    price: () => 0,
    sessionsDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-opencode-length-")),
    standIn: { command: process.execPath, args: [STAND_IN] },
    fetch: scriptedResponses(script),
  });
  const events = [];
  const io = { writer: await memorySessionStore().open("root"), models: { beforeRequest: async () => undefined, afterRequest: async () => undefined }, signal: new AbortController().signal, onEvent: (event) => events.push(event) };
  const session = await adapter.open({ key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" }, io);
  t.after(() => session.close());
  await session.send("Follow the script.");
  const end = await session.turnEnd();
  return { end, turnEnd: events.find((event) => event.type === "turn_end"), said: events.filter((event) => event.type === "text").map((event) => event.delta).join("") };
}

test("an answer cut at the output limit: the turn ends with stopReason length and the answer's output tokens", async (t) => {
  const { end, turnEnd, said } = await turnEndOf(t, [{ say: "half an answ", cut: true }]);
  assert.equal(said, "half an answ");
  assert.equal(end.status, "completed", "the turn itself completed: the run decides what a cut answer means");
  assert.deepEqual(turnEnd, { type: "turn_end", status: "completed", stopReason: "length", outputTokens: 10 });
});

test("a whole answer says no stop reason", async (t) => {
  const { turnEnd } = await turnEndOf(t, [{ say: "a whole answer" }]);
  assert.deepEqual(turnEnd, { type: "turn_end", status: "completed" });
});
