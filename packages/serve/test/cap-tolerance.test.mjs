// The cap's room is read within a float's tail (CAP_TOLERANCE). A request whose least, with what the run has spent, is
// the cap in decimal fits it: #1611's walk saw an opencode run refused there ($0.0028 spent, a $0.3072 least, a $0.31
// cap), then told to raise its cap to the $0.31 it had. A request past the cap names a raise a cent above it, never the
// cap itself, so the raise it names is one PATCH takes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capBefore } from "../dist/cap.js";

// The walk's gateway model as priced there: output at $100 a million, so 3,072 tokens are $0.3072.
const model = { id: "gpt-6-luna", name: "gpt-6-luna", api: "openai-responses", provider: "p", maxTokens: 64000, contextWindow: 400000, cost: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 } };

test("a request whose least and what was spent make the cap in decimal fits it, never refused by a float's tail", async () => {
  const cap = await capBefore(0.31, model);
  // $0.0028 spent; the least, 3,072 tokens, costs 0.30720000000000003 in a float, and 0.31 - 0.0028 is 0.3072.
  assert.deepEqual(cap.beforeRequest({ spentUsd: 0.0028, inFlight: [], inputTokensMax: 0, outputTokensLeast: 3072 }), { outputTokensMax: 3072 });
});

test("a request past the cap names a raise a cent above it, never the cap itself", async () => {
  const cap = await capBefore(0.31, model);
  for (const spentUsd of [0.0029, 0.0028 + 2e-9]) {
    const refused = cap.beforeRequest({ spentUsd, inFlight: [], inputTokensMax: 0, outputTokensLeast: 3072 })?.refuse ?? "";
    assert.match(refused, /Raise the cap to at least \$0\.32 to run it\.$/, `${spentUsd}: ${refused}`);
  }
});
