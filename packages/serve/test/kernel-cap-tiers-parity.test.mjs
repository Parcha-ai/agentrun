// The kernel cap's price (run-adapters kernel/cap/price.ts pricingOf) is pi-ai's calculateCost on the catalog's own
// model entry, tiers included: a request's fresh input at the dearer of the input and cache-write rates, its cached input
// at the cache-read rate, its output at the output rate, each at the rates of the tier its whole input passes. The
// kernel takes the catalog's cost table as given (no rate of its own); this holds it to pi-ai's rule on it, so a hold and
// a booking the kernel prices can never be under what the provider bills past a tier's threshold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCost } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const { pricingOf } = await import("../../run-adapters/dist/kernel/cap/index.js");

/** pi-ai's price of a request's input parts and output, the fresh input at the dearer of input and cache write. */
function piPrice(model, { cached, fresh }, output) {
  const priced = (tokens) => calculateCost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
  return Math.max(priced({ input: fresh, cacheRead: cached, output }), priced({ cacheWrite: fresh, cacheRead: cached, output }));
}

for (const [provider, id] of [["openrouter", "openai/gpt-6-sol"], ["openai", "gpt-6-sol"]]) {
  test(`${provider} ${id}: the kernel prices every request as pi-ai's calculateCost does, below, at and past its tier's threshold`, () => {
    const model = builtinModels({}).getModel(provider, id);
    assert.ok(model?.cost?.tiers?.length, `the catalog gives ${id} a tier: ${JSON.stringify(model?.cost)}`);
    const kernel = pricingOf(model.cost);
    const threshold = model.cost.tiers[0].inputTokensAbove;
    const inputs = [{ cached: 0, fresh: 100_000 }, { cached: 0, fresh: threshold }, { cached: 0, fresh: threshold + 1 }, { cached: threshold - 100_000, fresh: 100_001 }, { cached: 50_000, fresh: 400_000 }];
    for (const parts of inputs) {
      for (const output of [0, 1_024, model.maxTokens]) {
        const expected = piPrice(model, parts, output);
        assert.ok(Math.abs(kernel(parts, output) - expected) < 1e-12, `${JSON.stringify(parts)} out ${output}: kernel ${kernel(parts, output)}, pi-ai ${expected}`);
      }
    }
  });
}
