// OpenRouter's free models that take tools but that pi-ai's catalog does not list (particle-ai/particle-1:free, Baidu's
// ERNIE 5.5 Flash preview, inclusionAI's Ling 3.2 Flash) are serve's own entries (local-models.ts ADDED_MODELS): they
// resolve, run and are priced at a known $0 wherever serve reads a model. Capabilities say which of the models a person may
// pick for a harness are free (harnesses[].free_models, with each one's context window): those whose catalog price is all
// zeros, read from the price and never from the id; OpenRouter's routers, whose catalog zeros are no price, are not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDED_MODELS, isFree } from "../dist/local-models.js";
import { catalogPrice, catalogPrices, chooseModel, runModels, unpricedModels } from "../dist/model.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { serve, withEnv } from "./support.mjs";

const FREE = "particle-ai/particle-1:free";
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const KEY = `not-a-secret-${"router"}`;

test("openrouter/particle-ai/particle-1:free resolves on OpenRouter's key at $0: the paid entry's wire, its own id, Particle's context and tool format", async () => {
  const { models, model } = await runModels({ OPENROUTER_API_KEY: KEY }, `openrouter/${FREE}`);
  assert.equal(`${model.provider}/${model.modelId}`, `openrouter/${FREE}`);
  const full = models.getModel("openrouter", FREE);
  const paid = models.getModel("openrouter", "particle-ai/particle-1");
  assert.ok(full, "listed");
  assert.deepEqual(full.cost, ZERO);
  assert.deepEqual([full.api, full.baseUrl, full.reasoning, full.input, full.compat, full.thinkingLevelMap], [paid.api, paid.baseUrl, paid.reasoning, paid.input, paid.compat, paid.thinkingLevelMap]);
  assert.deepEqual([full.contextWindow, full.maxTokens, full.toolsAs, full.type], [1_048_576, 131_072, "text", "chat"]);
  assert.equal(isFree(full), true);
});

test("every added model is chosen on OpenRouter's key and runs at a known $0: a capped run on it has its price", async () => {
  for (const { id } of ADDED_MODELS) {
    const chosen = await chooseModel({ OPENROUTER_API_KEY: KEY }, `openrouter/${id}`, "default", "pi");
    assert.ok("model" in chosen, `${id}: ${JSON.stringify(chosen)}`);
    const { models, unpriced } = await runModels({ OPENROUTER_API_KEY: KEY }, `openrouter/${id}`);
    assert.deepEqual(models.getModel("openrouter", id)?.cost, ZERO, id);
    assert.deepEqual([...unpriced], [], id);
    assert.deepEqual(await unpricedModels({ OPENROUTER_API_KEY: KEY }, `openrouter/${id}`, ["default"], "pi"), [], id);
  }
  assert.deepEqual(ADDED_MODELS.map((m) => m.id), [FREE, "baidu/ernie-5.5-flash-preview:free", "inclusionai/ling-3.2-flash:free"]);
  // Behind a gateway a $0 catalog entry is no price (catalogPrices: a plan's $0 never prices a metered model), as for
  // pi-ai's own free entries: AGENT_MODEL_PRICE=0,0 says it there.
  assert.equal(catalogPrice(await catalogPrices(), `openrouter/${FREE}`, "openrouter"), undefined);
});

test("a request on particle-1:free goes to OpenRouter under its own id and its answer is booked at $0", async (t) => {
  const gw = await startFauxGateway({ usage: { input: 1_000_000, output: 1_000_000 } });
  t.after(() => gw.close());
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const { pathname, search } = new URL(url);
    return globalThis.fetch(`${gw.url}${pathname}${search}`, init);
  };
  const { models, model } = await runModels({ OPENROUTER_API_KEY: KEY }, `openrouter/${FREE}`);
  const full = models.getModel(model.provider, model.modelId);
  const answer = await models.getProvider(model.provider).streamSimple(full, { messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }] }, { apiKey: KEY, fetch }).result();
  assert.deepEqual([sent.length, sent[0].url, sent[0].body.model], [1, "https://openrouter.ai/api/v1/chat/completions", FREE]);
  assert.equal(answer.usage.cost.total, 0, JSON.stringify(answer.usage));
});

test("free is the price: all zeros, every tier too; a paid price, a tier above zero, or an OpenRouter router is not free", () => {
  assert.equal(isFree({ provider: "openrouter", id: "x/y", cost: ZERO }), true);
  assert.equal(isFree({ provider: "openrouter", id: "x/y:free", cost: { ...ZERO, output: 0.1 } }), false, "a :free id at a price is not free");
  assert.equal(isFree({ provider: "openrouter", id: "x/y", cost: { ...ZERO, tiers: [{ inputTokensAbove: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }] } }), false);
  for (const id of ["openrouter/auto", "openrouter/free", "auto", "typesafe/jev-router"]) assert.equal(isFree({ provider: "openrouter", id, cost: ZERO }), false, id);
});

const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const capsOn = async (t, env) => {
  withEnv(t, env, MODEL_VARS);
  const { api } = await serve(t, { faux: undefined });
  return (await api("GET", "/capabilities")).body.harnesses;
};

test("on OpenRouter's key, pi's free models are listed with their context windows, each also pickable; no router, no paid model", async (t) => {
  const harnesses = await capsOn(t, { OPENROUTER_API_KEY: KEY });
  const pi = harnesses.find((h) => h.id === "pi");
  const free = new Map(pi.free_models.map((m) => [m.id, m.context_window]));
  assert.equal(free.get(`openrouter/${FREE}`), 1_048_576);
  assert.equal(free.get("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"), 1_000_000, "pi-ai's own free entry");
  for (const id of ["openrouter/openrouter/free", "openrouter/openrouter/auto", "openrouter/auto", "openrouter/particle-ai/particle-1"]) assert.ok(!free.has(id), id);
  for (const { id } of pi.free_models) assert.ok(pi.models.includes(id), `${id} is pickable`);
  assert.ok(pi.models.includes("openrouter/anthropic/claude-sonnet-5.5"), "the paid models stay");
  for (const h of harnesses.filter((h) => h.id !== "pi")) assert.deepEqual(h.free_models, [], h.id);
});

test("with no OpenRouter key no free model is offered", async (t) => {
  const harnesses = await capsOn(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` });
  for (const h of harnesses) assert.deepEqual(h.free_models, [], h.id);
});
