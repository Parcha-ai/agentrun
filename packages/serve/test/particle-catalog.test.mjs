// OpenRouter's particle-ai/particle-1, which the pi family's pinned pi-ai (1.1.0) does not list: serve lists it itself
// (local-models.ts), with pi-ai 1.5.0's catalog entry at Particle's own list price ($0.25 input, $0.03 cached input,
// $1.00 output; never OpenRouter's current promotional $0.05/$0.003/$0.50), so every place serve reads a model's price or
// capabilities finds it: the run's models (providerModels), the gateway price table (catalogPrices, catalogPrice), and
// the models a capped run would have no price for (unpricedModels).
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogPrice, catalogPrices, providerModels, unpricedModels } from "../dist/model.js";

const ID = "particle-ai/particle-1";
const PRICE = { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 };

test("the run's models know particle-ai/particle-1 on OpenRouter, as pi-ai 1.5.0 lists it, at Particle's list price", async () => {
  const model = (await providerModels({})).getModel("openrouter", ID);
  assert.ok(model, "listed");
  assert.deepEqual([model.api, model.baseUrl, model.reasoning, model.input, model.contextWindow, model.maxTokens, model.cost], ["openai-completions", "https://openrouter.ai/api/v1", true, ["text", "image"], 1_048_576, 131_072, PRICE]);
  assert.deepEqual([model.compat?.thinkingFormat, model.compat?.supportsDeveloperRole, model.compat?.supportsStrictMode, model.compat?.sendSessionAffinityHeaders], ["openrouter", false, true, true]);
});

test("the gateway price table prices it at Particle's list price, $0.25/$1.00 (cache read $0.03), whole and by its OpenRouter name", async () => {
  const catalog = await catalogPrices();
  assert.deepEqual(catalogPrice(catalog, ID, undefined), PRICE);
  assert.deepEqual(catalogPrice(catalog, `openrouter/${ID}`, "openrouter"), PRICE);
});

test("a capped run on it through a gateway has its price: it is no model serve cannot price", async () => {
  assert.deepEqual(await unpricedModels({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: ID }, undefined, ["default"], "pi"), []);
});
