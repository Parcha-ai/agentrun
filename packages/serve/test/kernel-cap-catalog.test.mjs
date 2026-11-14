// The kernel cap on models as the catalog lists them, where a wrong price or ceiling would let a request pass its cap:
// pi on OpenRouter's Claude Sonnet 5.5 at a $1 cap (Q8-1: at its whole 128,000-token ceiling a request could cost $1.28, so
// the first request was refused; it goes, limited to what $1 buys), and particle-ai/particle-1 at Particle's list price
// (serve sets it over the catalog's promotional one, local-models.ts), so a hold never prices a request below what can be billed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { capOn, modelRequest } from "../../run-adapters/test/kernel-cap-support.mjs";

const { providerModels } = await import("../dist/model.js");

/** The kernel's model entry for a catalog model: its price, its output ceiling and whether it thinks. */
const entry = (model) => ({ id: model.id, api: model.api, price: model.cost, outputCeiling: model.maxTokens, reasoning: model.reasoning });

test("pi on OpenRouter's Claude Sonnet 5.5 at a $1 cap: the first request goes with the output $1 buys, thinking included", async () => {
  const sonnet = builtinModels({}).getModel("openrouter", "anthropic/claude-sonnet-5.5");
  assert.ok(sonnet, "the catalog lists it");
  const perToken = sonnet.cost.output / 1e6;
  assert.ok(sonnet.maxTokens * perToken > 1, `its ceiling alone is over $1: ${sonnet.maxTokens} tokens at $${sonnet.cost.output} a million`);
  const { cap } = capOn(1, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(entry(sonnet), 20, sonnet.maxTokens, { thinkingBudget: 8_000 }));
  const max = admitted.outputTokensMax;
  assert.ok(max < sonnet.maxTokens && max * perToken < 1, `max_tokens ${max} is within $1`);
  assert.ok(max > 90_000, `max_tokens ${max} is about what $1 buys, less the input`);
  assert.ok(admitted.thinkingBudget >= 1_024 && admitted.thinkingBudget <= max - 1_024, `thinking ${admitted.thinkingBudget}`);
  assert.ok(admitted.heldUsd <= 1, `held within the cap: ${admitted.heldUsd}`);
});

test("the cap's hold for a particle-1 request is its worst case at the list price, never the catalog's promotional one", async () => {
  // Its worst case is its 131,072 output tokens: $0.131 at $1.00 a million, $0.066 at $0.50. A strict cap of $0.10 limits the
  // request's output to what fits: under 100,000 tokens at the list price, where the promotional price would let all 131,072 go.
  const model = (await providerModels({})).getModel("openrouter", "particle-ai/particle-1");
  const { cap } = capOn(0.1, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(entry(model), 10, model.maxTokens));
  const allowed = admitted.outputTokensMax;
  assert.ok(typeof allowed === "number" && allowed <= 100_000 && allowed > 99_000, `its output is held at the list price: $0.10 buys at most 100,000 tokens at $1.00 a million, not 131,072 at $0.50 (admitted with ${allowed})`);
});
