// A gateway model's price, which a run's cost is reckoned from: AGENT_MODEL_PRICE (or its tier's) when set, else the list
// price pi-ai's catalog gives that model id (a $0 entry included), else none: the cost of its answers is then unknown,
// never $0. No network: runModels only builds the models, and the runs below talk to a Responses endpoint on loopback.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { calculateCost } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { timelineOf } from "@parcha/pi-durable-agent/timeline";
import { runModels } from "../dist/model.js";
import { agent, follow, responsesEndpoint, serve } from "./support.mjs";

const GATEWAY = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9" };
const costOf = async (env, tiers = ["default"], ref = undefined) => {
  const { models, byTier } = await runModels({ ...GATEWAY, ...env }, ref, tiers);
  return Object.fromEntries(tiers.map((tier) => { const ref = byTier.get(tier); return [tier, models.getModel(ref.provider, ref.modelId).cost]; }));
};
/** The catalog's entries for `id`, one per provider that lists it. */
const entries = (id) => builtinModels().getModels().filter((model) => model.id === id);
const total = (cost) => cost.input + cost.output;
/** The highest whole price the catalog lists for `id`: the entry with the most input plus output. */
const highest = (id) => entries(id).reduce((top, { cost }) => (total(cost) > total(top) ? cost : top), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

test("a gateway model the catalog knows takes its list price; a set price wins; an id the catalog does not list has no price", async () => {
  const listed = builtinModels().getModels().find((model) => model.id === "gpt-6-luna" && model.cost.input > 0);
  assert.ok(listed, "pi-ai's catalog prices gpt-6-luna");
  const luna = highest("gpt-6-luna");
  assert.deepEqual((await costOf({ AGENT_MODEL: "gpt-6-luna" })).default, luna);
  assert.deepEqual((await costOf({ AGENT_MODEL: "gpt-6-luna", AGENT_MODEL_PRICE: "2,4,0.2" })).default, { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 });
  assert.deepEqual([...(await runModels({ ...GATEWAY, AGENT_MODEL: "not-a-catalog-model" }, undefined)).unpriced], ["not-a-catalog-model"], "an id the catalog does not list has no price");
  assert.deepEqual([...(await runModels({ ...GATEWAY, AGENT_MODEL: "gpt-6-luna" }, undefined)).unpriced], [], "a listed one has its price");
  assert.deepEqual([...(await runModels({ ...GATEWAY, AGENT_MODEL: "not-a-catalog-model", AGENT_MODEL_PRICE: "0,0" }, undefined)).unpriced], [], "a set price is known, $0 included");
  // A tier's own price goes with its model; the other tier, with no price of its own, takes the catalog's.
  const tiers = await costOf({ AGENT_MODEL: "not-a-catalog-model", AGENT_MODEL_FAST: "gpt-6-luna", AGENT_MODEL_PRICE: "3,6" }, ["default", "fast"]);
  assert.deepEqual(tiers.default, { input: 3, output: 6, cacheRead: 0, cacheWrite: 3 });
  assert.deepEqual(tiers.fast, { input: 3, output: 6, cacheRead: 0, cacheWrite: 3 }, "AGENT_MODEL_PRICE is every tier's price unless the tier sets its own");
  const own = await costOf({ AGENT_MODEL: "not-a-catalog-model", AGENT_MODEL_FAST: "gpt-6-luna" }, ["default", "fast"]);
  assert.deepEqual(own.fast, luna);
});

test("a tier's own price wins for its model over the shared AGENT_MODEL_PRICE and over the catalog; a tier without one takes the shared price", async () => {
  // Three distinct models, so each tier's price goes with its own model (a model two tiers share takes the default's).
  const env = {
    AGENT_MODEL: "not-a-catalog-default", AGENT_MODEL_FAST: "gpt-6-luna", AGENT_MODEL_STRONG: "not-a-catalog-strong",
    AGENT_MODEL_PRICE: "3,6", AGENT_MODEL_FAST_PRICE: "0.5,1.5,0.05", AGENT_MODEL_STRONG_PRICE: "9,18,0.9,11",
  };
  const prices = await costOf(env, ["default", "fast", "strong"]);
  assert.deepEqual(prices.default, { input: 3, output: 6, cacheRead: 0, cacheWrite: 3 }, "the default tier takes AGENT_MODEL_PRICE");
  assert.deepEqual(prices.fast, { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.5 }, "AGENT_MODEL_FAST_PRICE wins over AGENT_MODEL_PRICE");
  assert.notDeepEqual(prices.fast, highest("gpt-6-luna"), "and over the catalog's list price for the fast model");
  assert.deepEqual(prices.strong, { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 11 }, "AGENT_MODEL_STRONG_PRICE wins over AGENT_MODEL_PRICE");
  const shared = await costOf({ ...env, AGENT_MODEL_STRONG_PRICE: "" }, ["strong"]);
  assert.deepEqual(shared.strong, { input: 3, output: 6, cacheRead: 0, cacheWrite: 3 }, "a tier with no price of its own takes AGENT_MODEL_PRICE");
});

test("an id several providers price: the ref's own provider's paid entry when the catalog lists one, else the highest whole entry, never a $0 one over a paid one", async () => {
  for (const id of ["gpt-4o", "deepseek-v4-pro"]) {
    assert.ok(new Set(entries(id).map(({ cost }) => total(cost))).size > 1, `the catalog prices ${id} differently by provider`);
    const bare = (await costOf({ AGENT_MODEL: id })).default;
    assert.deepEqual(bare, highest(id), `${id} bare: the highest`);
    assert.ok(entries(id).some(({ cost }) => isDeepStrictEqual(cost, bare)), `${id} bare: one entry's whole price, not a mix`);
    assert.deepEqual((await costOf({}, ["default"], `agent-model/${id}`)).default, highest(id), `${id}: a provider the catalog does not list for it prices as bare`);
    assert.deepEqual((await costOf({ AGENT_MODEL_PRICE: "7,8" }, ["default"], `openai/${id}`)).default, { input: 7, output: 8, cacheRead: 0, cacheWrite: 7 }, "a set price wins over the named provider's");
  }
  for (const [provider, id] of [["cloudflare-ai-gateway", "gpt-4o"], ["deepseek", "deepseek-v4-pro"]]) {
    const own = builtinModels().getModel(provider, id).cost;
    assert.notDeepEqual(own, highest(id), `${provider} does not list the highest price for ${id}`);
    assert.deepEqual((await costOf({}, ["default"], `${provider}/${id}`)).default, own, `${provider}/${id}: its own entry`);
  }
  // A named provider the catalog lists at $0 for an id others price is a hint, not who answers: the highest paid entry.
  const free = entries("deepseek-v4-pro").find(({ cost }) => total(cost) === 0) ?? builtinModels().getModels().find((model) => total(model.cost) === 0 && total(highest(model.id)) > 0);
  assert.ok(free, "the catalog lists some provider at $0 for an id others price");
  assert.ok(total(highest(free.id)) > 0);
  assert.deepEqual((await costOf({}, ["default"], `${free.provider}/${free.id}`)).default, highest(free.id), `${free.provider}/${free.id}: listed at $0, priced at the highest paid entry`);
  // An id listed at $0 first and at several paid prices: bare, it takes the highest paid one, never the $0 entry and
  // never merely the first paid one.
  const mixed = [...new Set(builtinModels().getModels().map((model) => model.id))].find((id) => {
    const [first, ...rest] = entries(id);
    const paid = rest.filter(({ cost }) => total(cost) > 0);
    return total(first.cost) === 0 && paid.length > 1 && total(paid[0].cost) < total(highest(id));
  });
  assert.ok(mixed, "the catalog has an id listed at $0 first and at several paid prices");
  assert.deepEqual((await costOf({ AGENT_MODEL: mixed })).default, highest(mixed), mixed);
});

test("through a gateway a revision's provider/model-id is sent whole (OpenRouter names its models so); AGENT_MODEL_GATEWAY_IDS=bare sends the part after the provider", async () => {
  const sent = async (env, ref) => (await runModels({ ...GATEWAY, AGENT_MODEL: "host-default", ...env }, ref, ["default"])).byTier.get("default").modelId;
  assert.equal(await sent({}, "openai/gpt-4o"), "openai/gpt-4o");
  assert.equal(await sent({}, "anthropic/claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5");
  assert.equal(await sent({ AGENT_MODEL_GATEWAY_IDS: "bare" }, "openai/gpt-4o"), "gpt-4o");
  assert.equal(await sent({}, undefined), "host-default", "the host's own model goes as it is set");
  // Priced either way as the named provider's entry for the model.
  const own = entries("gpt-4o").find((entry) => entry.provider === "cloudflare-ai-gateway").cost;
  assert.deepEqual((await costOf({}, ["default"], "cloudflare-ai-gateway/gpt-4o")).default, own);
  assert.deepEqual((await costOf({ AGENT_MODEL_GATEWAY_IDS: "bare" }, ["default"], "cloudflare-ai-gateway/gpt-4o")).default, own);
  // The host's own model goes as it is set, bare or not; only the exact value "bare" changes a revision's.
  assert.equal(await sent({ AGENT_MODEL_GATEWAY_IDS: "bare", AGENT_MODEL: "openai/gpt-4o" }, undefined), "openai/gpt-4o");
  for (const value of ["whole", "1", "BARE", "true"]) assert.equal(await sent({ AGENT_MODEL_GATEWAY_IDS: value }, "openai/gpt-4o"), "openai/gpt-4o", value);
  // A host model set whole, as OpenRouter names it, that the catalog lists only bare: priced as that vendor's entry.
  const ids = new Set(builtinModels().getModels().map((model) => model.id));
  const bare = builtinModels().getModels().find((model) => total(model.cost) > 0 && !ids.has(`${model.provider}/${model.id}`) && total(model.cost) !== total(highest(model.id)));
  assert.ok(bare, "the catalog has a model listed only bare whose provider prices it below the highest");
  const vendorCost = entries(bare.id).find((entry) => entry.provider === bare.provider).cost;
  assert.deepEqual((await costOf({ AGENT_MODEL: `${bare.provider}/${bare.id}` })).default, vendorCost, `${bare.provider}/${bare.id}`);
});

test("max_cost_usd applies to a gateway model the catalog prices: its response passes the cap and the run stops with spend_cap_reached; an id the catalog does not know reads its cost unknown, never $0", async (t) => {
  const tokens = 1_000_000;
  const endpoint = await responsesEndpoint(t, "42", tokens);
  const names = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_PRICE", "AGENT_MODEL_API_KEY"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  for (const name of names) delete process.env[name];
  process.env.AGENT_MODEL_BASE_URL = endpoint.url;
  const { api } = await serve(t, { faux: undefined });
  const run = async (id, model) => {
    assert.equal((await api("POST", "/agents", agent(id, { model }))).status, 201);
    // gpt-4o's worst case for one request (32k output tokens at its list price) is under $1; the endpoint's million
    // tokens each way cost far more.
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "What is six times seven?" }, max_cost_usd: 1 });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed"]);
    return (await api("GET", `/runs/${started.body.run_id}`)).body;
  };
  const priced = await run("priced", "openai/gpt-4o");
  assert.ok(endpoint.models.length > 0 && endpoint.models.every((model) => model === "openai/gpt-4o"), `the gateway is asked for the revision's model whole: ${endpoint.models}`);
  assert.deepEqual([priced.status, priced.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(priced.error));
  const usage = { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const expected = calculateCost(builtinModels().getModel("openai", "gpt-4o"), usage).total;
  assert.ok(Math.abs(priced.cost.usd - expected) < 1e-9, `the run's cost is openai's list price for its usage: ${priced.cost.usd} vs ${expected}`);
  const free = await run("free", "agent-model/not-a-catalog-model");
  assert.deepEqual([free.status, free.error ?? null, free.cost.usd], ["completed", null, null], JSON.stringify(free));
  // Each run's turns went to the gateway (other processes on the machine may probe a loopback port with a GET).
  const posts = endpoint.asked.filter((line) => line.startsWith("POST "));
  assert.ok(posts.length >= 2 && posts.every((line) => line === "POST /responses"), endpoint.asked.join(", "));
});

/** One answer of `tier` of `env`'s gateway at `url`: the message pi writes as its entry. */
const answerOf = async (url, env, tier = "default", how = "streamSimple") => {
  // Every tier `env` names, as one run builds them: a run's models share one provider.
  const tiers = ["default", ...(env.AGENT_MODEL_FAST ? ["fast"] : [])];
  const { models, byTier } = await runModels({ AGENT_MODEL_BASE_URL: url, AGENT_MODEL_API_KEY: "none", ...env }, undefined, tiers);
  const ref = byTier.get(tier);
  const model = models.getModel(ref.provider, ref.modelId);
  const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
  return how === "completeSimple" ? models.completeSimple(model, context) : models.streamSimple(model, context).result();
};
const usdOf = (messages) => timelineOf(messages.map((message, i) => ({ kind: "pi.assistant", id: i + 1, conversationId: 0, model: [message] })), { settled: true }).find((row) => row.kind === "usage")?.usage.usd;

test("an answer of a model with no price carries no total, so its run's cost is unknown; a priced one, catalog or set, keeps its total; one unknown answer makes the run's cost unknown", async (t) => {
  const endpoint = await responsesEndpoint(t, "42", 1_000);
  const unpriced = await answerOf(endpoint.url, { AGENT_MODEL: "not-a-catalog-model" });
  assert.equal(unpriced.stopReason, "stop", JSON.stringify(unpriced));
  assert.equal(unpriced.usage.cost.total, undefined, "no price: no total");
  const listed = await answerOf(endpoint.url, { AGENT_MODEL: "gpt-4o" });
  assert.ok(listed.usage.cost.total > 0, `the catalog's price: ${listed.usage.cost.total}`);
  const given = await answerOf(endpoint.url, { AGENT_MODEL: "not-a-catalog-model", AGENT_MODEL_PRICE: "2,4" });
  assert.ok(given.usage.cost.total > 0, `a set price: ${given.usage.cost.total}`);
  const zero = await answerOf(endpoint.url, { AGENT_MODEL: "not-a-catalog-model", AGENT_MODEL_PRICE: "0,0" });
  assert.equal(zero.usage.cost.total, 0, "a set price of $0 is a known $0");
  // A tier of the same run with no price of its own beside a priced one: the unpriced tier's answers alone lose their total.
  const fast = await answerOf(endpoint.url, { AGENT_MODEL: "gpt-4o", AGENT_MODEL_FAST: "not-a-catalog-fast" }, "fast");
  assert.equal(fast.usage.cost.total, undefined, "the unpriced tier");
  const beside = await answerOf(endpoint.url, { AGENT_MODEL: "gpt-4o", AGENT_MODEL_FAST: "not-a-catalog-fast" }, "default");
  assert.equal(beside.usage.cost.total, listed.usage.cost.total, "the priced tier of that same run keeps its total");
  assert.equal(usdOf([listed]), Math.round(listed.usage.cost.total * 1e6) / 1e6, "a priced answer alone: its cost");
  assert.equal(usdOf([listed, unpriced]), null, "with an unpriced one beside it: unknown, never the priced part alone");
  assert.equal(usdOf([zero]), 0, "a set $0: known");
  // pi's compaction summary asks through completeSimple, the same provider: its cost is unknown too (request-start writes it as null).
  const summary = await answerOf(endpoint.url, { AGENT_MODEL: "not-a-catalog-model" }, "default", "completeSimple");
  assert.equal(summary.usage.cost.total, undefined, "a compaction's answer");
});

test("a model the catalog lists at $0 is a known $0, not one with no price", async () => {
  const free = builtinModels().getModels().find((model) => entries(model.id).length > 0 && entries(model.id).every(({ cost }) => total(cost) === 0));
  assert.ok(free, "pi-ai's catalog lists a model at $0");
  const { unpriced } = await runModels({ ...GATEWAY, AGENT_MODEL: free.id }, undefined);
  assert.deepEqual([...unpriced], [], `${free.id} is listed, so its price is known`);
  assert.deepEqual((await costOf({ AGENT_MODEL: free.id })).default, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
