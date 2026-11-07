// OpenRouter's particle-ai/particle-1, as pi-ai 1.5.0's own catalog lists it, at Particle's own list price ($0.25 input,
// $0.03 cached input, $1.00 output; never OpenRouter's current promotional $0.05/$0.003/$0.50, which is the catalog's):
// serve sets the price over the catalog's entry (local-models.ts PRICE_OVERRIDES), so a cap's hold never prices a request
// below what can be billed. Every place serve reads a model's price or capabilities finds it: the run's models
// (providerModels), the gateway price table (catalogPrices, catalogPrice), and the models a capped run would have no price
// for (unpricedModels).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { capModels } from "../dist/cap.js";
import { PARTICLE_1_PRICE, PRICE_OVERRIDES } from "../dist/local-models.js";
import { catalogPrice, catalogPrices, providerModels, runModels, unpricedModels } from "../dist/model.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const ID = "particle-ai/particle-1";
const PRICE = { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 };

test("pi-ai 1.5.0's own catalog lists particle-ai/particle-1 at OpenRouter's promotional price; serve copies no entry, only sets its price", async () => {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const catalog = builtinModels().getModel("openrouter", ID);
  assert.ok(catalog, "pi-ai lists it");
  assert.deepEqual(catalog.cost, { input: 0.05, output: 0.5, cacheRead: 0.003, cacheWrite: 0 }, "the catalog's promotional price");
  assert.deepEqual(PRICE_OVERRIDES.map(({ provider, id }) => `${provider}/${id}`), [`openrouter/${ID}`]);
});

test("the cap's hold for a particle-1 request is its worst case at the list price, never the catalog's promotional one", async () => {
  // Its worst case is its 131,072 output tokens: $0.131 at $1.00 a million, $0.066 at $0.50. A strict cap (each request
  // held at its worst case) of $0.10 clamps the request's output to what fits: under 100,000 tokens at the list price,
  // where the promotional price would let all 131,072 go.
  const model = (await providerModels({})).getModel("openrouter", ID);
  const sent = [];
  const send = (_model, _context, options) => {
    const events = createAssistantMessageEventStream();
    sent.push(options?.maxTokens);
    const message = { role: "assistant", content: [{ type: "text", text: "hi" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => { events.push({ type: "done", reason: "stop", message }); events.end(message); });
    return events;
  };
  const fake = { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result(), streamDeferred: send, fetchDeferred: (...a) => send(...a).result() };
  const capped = await capModels(fake, 0.1, 0, { mode: "strict" });
  await capped.streamSimple(model, { messages: [{ role: "user", content: "Say hi.", timestamp: 0 }] }).result();
  assert.equal(sent.length, 1, "sent once");
  const allowed = sent[0];
  assert.ok(typeof allowed === "number" && allowed <= 100_000 && allowed > 99_000, `its output is held at the list price: $0.10 buys at most 100,000 tokens at $1.00 a million, not 131,072 at $0.50 (sent with maxTokens ${allowed})`);
});

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

test("a run on openrouter/particle-ai/particle-1 sends its request through OpenRouter's provider: /api/v1/chat/completions, its id, the run's key, OpenRouter's reasoning effort, and the answer is priced at Particle's list price", async (t) => {
  // As openrouter-effort.test.mjs sends a request: to https://openrouter.ai as pi-ai's provider builds it, through a fetch
  // that records it and hands it to a loopback gateway that answers with 1M input and 1M output tokens. No real key.
  const KEY = `not-a-secret-${"x"}`;
  const gw = await startFauxGateway({ usage: { input: 1_000_000, output: 1_000_000 } });
  t.after(() => gw.close());
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const { pathname, search } = new URL(url);
    return globalThis.fetch(`${gw.url}${pathname}${search}`, init);
  };
  const { models, model } = await runModels({ OPENROUTER_API_KEY: KEY }, `openrouter/${ID}`);
  assert.equal(`${model.provider}/${model.modelId}`, `openrouter/${ID}`);
  const full = models.getModel(model.provider, model.modelId);
  const answer = await models.getProvider(model.provider).streamSimple(full, { messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }] }, { reasoning: "medium", apiKey: KEY, fetch }).result();
  assert.equal(sent.length, 1, "one request");
  assert.deepEqual([sent[0].url, sent[0].body.model, sent[0].authorization], ["https://openrouter.ai/api/v1/chat/completions", ID, `Bearer ${KEY}`]);
  // thinkingFormat "openrouter" and the entry's thinkingLevelMap: medium is sent as OpenRouter's reasoning effort.
  assert.deepEqual(sent[0].body.reasoning, { effort: "medium" });
  // 1M input at $0.25 and 1M output at $1.00: $1.25 (PARTICLE_1_PRICE), never OpenRouter's promotional $0.55.
  assert.deepEqual([PARTICLE_1_PRICE.input, PARTICLE_1_PRICE.output], [0.25, 1]);
  assert.ok(Math.abs(answer.usage.cost.total - 1.25) < 1e-9, `priced at the list price: ${JSON.stringify(answer.usage)}`);
});
