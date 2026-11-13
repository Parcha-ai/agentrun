// The spend cap's wrap-up note on OpenCode's route (OpenAI's Responses API, the policy's addNote): one developer message
// appended to the input, after everything OpenCode sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openCodePolicy } from "../dist/harness-opencode/host/policy.js";

const NOTE = "About $0.07 left of this run's budget: finish now with your answer.";

test("the note: one trailing developer message, every earlier input item as OpenCode sent it", () => {
  const policy = openCodePolicy({ model: "gpt-test", tools: ["read"] });
  assert.equal(typeof policy.addNote, "function", "the policy places a note");
  const sent = { model: "gpt-test", input: [{ role: "user", content: [{ type: "input_text", text: "Write the report." }] }] };
  const noted = policy.addNote?.(structuredClone(sent), NOTE);
  assert.deepEqual(noted?.input?.slice(0, -1), sent.input, "earlier items unchanged");
  assert.deepEqual(noted.input.at(-1), { type: "message", role: "developer", content: [{ type: "input_text", text: NOTE }] });
});
