// A gateway model's price, which a run's cost is reckoned from: AGENT_MODEL_PRICE (or its tier's) when set, else the list
// price pi-ai's catalog gives that model id, else $0. No network: runModels only builds the models.
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { runModels } from "../dist/model.js";

const GATEWAY = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9" };
const costOf = async (env, tiers = ["default"]) => {
  const { models, byTier } = await runModels({ ...GATEWAY, ...env }, undefined, tiers);
  return Object.fromEntries(tiers.map((tier) => { const ref = byTier.get(tier); return [tier, models.getModel(ref.provider, ref.modelId).cost]; }));
};

test("a gateway model the catalog knows takes its list price; a set price wins; an unknown one is $0", async () => {
  const listed = builtinModels().getModels().find((model) => model.id === "gpt-6-luna" && model.cost.input > 0);
  assert.ok(listed, "pi-ai's catalog prices gpt-6-luna");
  const { input, output, cacheRead, cacheWrite } = listed.cost;
  assert.deepEqual((await costOf({ AGENT_MODEL: "gpt-6-luna" })).default, { input, output, cacheRead, cacheWrite });
  assert.deepEqual((await costOf({ AGENT_MODEL: "gpt-6-luna", AGENT_MODEL_PRICE: "2,4,0.2" })).default, { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 });
  assert.deepEqual((await costOf({ AGENT_MODEL: "not-a-catalog-model" })).default, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // A tier's own price goes with its model; the other tier, with no price of its own, takes the catalog's.
  const tiers = await costOf({ AGENT_MODEL: "not-a-catalog-model", AGENT_MODEL_FAST: "gpt-6-luna", AGENT_MODEL_PRICE: "3,6" }, ["default", "fast"]);
  assert.deepEqual(tiers.default, { input: 3, output: 6, cacheRead: 0, cacheWrite: 3 });
  assert.deepEqual(tiers.fast, { input: 3, output: 6, cacheRead: 0, cacheWrite: 3 }, "AGENT_MODEL_PRICE is every tier's price unless the tier sets its own");
  const own = await costOf({ AGENT_MODEL: "not-a-catalog-model", AGENT_MODEL_FAST: "gpt-6-luna" }, ["default", "fast"]);
  assert.deepEqual(own.fast, { input, output, cacheRead, cacheWrite });
});
