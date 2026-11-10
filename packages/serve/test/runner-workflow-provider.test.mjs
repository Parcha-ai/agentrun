// The workflow run's model provider from the runner's model route (runner/workflow-spec.ts providerFromRoute and
// routeProviderOf over model-route.ts routeOf): a workflow model node resolves its model the one way the runner resolves
// any (the pi adapter's path), so the proxy's provider, the booking's price and the cap's model all come from the route.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const { providerFromRoute, routeProviderOf } = await import("../dist/runner/workflow-spec.js");

const FAUX = fileURLToPath(new URL("./fixtures/faux-route.mjs", import.meta.url));

test("providerFromRoute maps a resolved route to the workflow provider: the proxy's provider, the booking's price, the cap's model", async () => {
  const cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] };
  const route = {
    provider: { api: "anthropic-messages", origin: "https://example.test", credential: () => "a-key", headers: { "x-h": "v" } },
    model: "openai/gpt-6-sol",
    price: (_m, u) => (u.input * 2 + u.output * 10) / 1e6,
    cost,
    outputCeiling: 128_000,
    fetch: async () => new Response(""),
  };
  const provider = await providerFromRoute(route);
  assert.equal(provider.modelId, "openai/gpt-6-sol");
  assert.equal(provider.api, "anthropic-messages");
  assert.equal(provider.origin, "https://example.test");
  assert.equal(await provider.credential(), "a-key");
  assert.deepEqual(provider.headers, { "x-h": "v" });
  assert.equal(typeof provider.fetch, "function");
  assert.ok(provider.policy && typeof provider.policy === "object", "the proxy's policy is built");
  assert.equal(provider.price("openai/gpt-6-sol", { input: 1_000, output: 100 }), (1_000 * 2 + 100 * 10) / 1e6, "the booking's price is the route's");
  assert.deepEqual(provider.capModel, { id: "openai/gpt-6-sol", api: "anthropic-messages", price: cost, outputCeiling: 128_000 }, "the cap's model is the catalog cost (tiers) and the output ceiling");
});

test("a route with no catalog cost or ceiling: the cap's model is unpriced with no ceiling", async () => {
  const provider = await providerFromRoute({ provider: { api: "anthropic-messages", origin: "https://x.test", credential: () => "" }, model: "m" });
  assert.deepEqual(provider.capModel, { id: "m", api: "anthropic-messages", price: null, outputCeiling: null });
  assert.equal(provider.price("m", { input: 1, output: 1 }), null, "no route price: unknown");
  assert.equal(provider.fetch, undefined);
});

test("routeProviderOf resolves a tier's model through the runner's route (the faux model), priced from its catalog", async () => {
  const provider = await routeProviderOf({ AGENTRUN_SERVE_FAUX: FAUX })("default");
  assert.equal(provider.modelId, "faux-1");
  assert.equal(provider.api, "anthropic-messages");
  assert.equal(provider.capModel.price?.input, 3, "the catalog cost is the cap's model price");
  assert.equal(provider.capModel.price?.output, 15);
  assert.equal(provider.price("faux-1", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 3, "the booking prices a million input tokens at the catalog rate");
  assert.equal(typeof provider.fetch, "function", "the faux model answers through the route's fetch, never the network");
  assert.ok(provider.policy, "the proxy's policy is built");
});
