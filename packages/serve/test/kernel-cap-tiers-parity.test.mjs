// The kernel cap's price (run-adapters kernel/cap/price.ts pricingOf) is pi-ai's calculateCost on the catalog's own
// model entry, tiers included, for a request with none of its input read from the cache: its whole input at the dearer
// of the input and cache-write rates, its output at the output rate, each at the rates of the tier its whole input
// passes. The kernel takes the catalog's cost table as given (no rate of its own); this holds it to pi-ai's rule on it,
// so a hold the kernel prices can never be under what the provider bills past a tier's threshold, whatever the cache did.
import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCost } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const { pricingOf } = await import("../../run-adapters/dist/kernel/cap/index.js");

/** pi-ai's price of `input` tokens, none of them cached, and `output`: the input at the dearer of input and cache write. */
function piPrice(model, input, output) {
  const priced = (tokens) => calculateCost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
  return Math.max(priced({ input, output }), priced({ cacheWrite: input, output }));
}

for (const [provider, id] of [["openrouter", "openai/gpt-6.1-sol"], ["openai", "gpt-6.1-sol"]]) {
  test(`${provider} ${id}: the kernel prices every request's whole input uncached as pi-ai's calculateCost does, below, at and past its tier's threshold`, () => {
    const model = builtinModels({}).getModel(provider, id);
    assert.ok(model?.cost?.tiers?.length, `the catalog gives ${id} a tier: ${JSON.stringify(model?.cost)}`);
    const kernel = pricingOf(model.cost);
    const threshold = model.cost.tiers[0].inputTokensAbove;
    for (const input of [100_000, threshold, threshold + 1, 450_000]) {
      for (const output of [0, 1_024, model.maxTokens]) {
        const expected = piPrice(model, input, output);
        assert.ok(Math.abs(kernel(input, output) - expected) < 1e-12, `${input} in, ${output} out: kernel ${kernel(input, output)}, pi-ai ${expected}`);
      }
    }
  });
}
