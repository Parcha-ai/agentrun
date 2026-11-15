// What a request on OpenRouter is booked at, on the runner's route (model-route.ts routeOf) and its proxy (pi.ts
// openTierProxies, as pi's session and a tier's side requests reach it).
// - OpenRouter states what it charged in each answer's usage (`cost`, USD), often below the catalog's list price (it
//   picks one of a model's providers): pi-ai reads it (totalFromProvider), the route's translation hands it on, and the
//   proxy books it, the table's figure beside it. The cap still holds the request at list (capModelOf).
// - OpenRouter's routers (openrouter/auto and the rest) pick a model per request: pi-ai's catalog lists them at $0, which
//   is the price of no model. Serve has no price for them: under a cap a router is refused before it starts, and it is
//   never booked $0: with no cap, at what OpenRouter said it cost, else unknown.
// - OpenRouter answers 200 before the model's first token, so a rate limit after that comes inside the stream: booked as
//   refused at $0, in the provider's words.
// The upstream here is a stand-in for OpenRouter's Chat Completions endpoint: nothing leaves loopback.
import assert from "node:assert/strict";
import { test } from "node:test";

const { routeOf } = await import("../dist/runner/model-route.js");
const { capModelOf } = await import("../dist/runner/adapter-run-spec.js");
const { providerFromRoute } = await import("../dist/runner/workflow-spec.js");
const { openTierProxies } = await import("../dist/runner/adapters/pi.js");
const { runModels, unpricedModels } = await import("../dist/model.js");
const { blockersOf } = await import("../dist/runnable.js");

/** OpenRouter's key, plainly a test value. */
const KEY = `not-a-secret-${"openrouter"}`;
const OR_ALONE = { OPENROUTER_API_KEY: KEY };
const MODEL = "openrouter/openai/gpt-6.1-sol";
const ROUTER = "openrouter/openrouter/auto";
// gpt-6.1-sol at OpenRouter's catalog list price ($2 / $10 per million): 10,000 input and 500 output tokens.
const USAGE = { prompt_tokens: 10_000, completion_tokens: 500, total_tokens: 10_500 };
const LIST_USD = (10_000 * 2 + 500 * 10) / 1e6;
const CHARGED_USD = 0.01;
const LIMITED = "Rate limit exceeded: free-models-per-min";

const chunk = (fields) => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-6.1-sol", ...fields })}\n\n`;
/** A Chat Completions stream: a text answer, then its usage (with `usage`'s extra fields, OpenRouter's cost), or OpenRouter's
 *  mid-stream error (a 429 in the body of a 200, https://openrouter.ai/docs/api-reference/errors). */
const answer = (extra) => chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello." }, finish_reason: null }] })
  + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  + chunk({ choices: [], usage: { ...USAGE, ...extra } })
  + "data: [DONE]\n\n";
const limited = () => chunk({ error: { code: 429, message: LIMITED, metadata: { error_type: "rate_limit_exceeded" } }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }) + "data: [DONE]\n\n";

/** OpenRouter's stand-in: each request to its Chat Completions endpoint answered `body`, every request listed. */
function upstream(body) {
  const asked = [];
  const fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url !== "https://openrouter.ai/api/v1/chat/completions") return new Response("not here", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, asked };
}

/** One side request through `route`'s proxy (a tier's, as pi's session reaches it), and what the proxy booked for it. */
async function bookedOn(t, route) {
  const booked = [];
  const hooks = { beforeRequest: async () => ({ turn: 1 }), afterRequest: async (usage, _ticket, ended) => void booked.push({ usage, ended }) };
  const tiers = await openTierProxies(new Map([["fast", route]]), hooks);
  t.after(() => tiers.close());
  const port = tiers.port("side", "fast");
  const response = await fetch(`${port.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${port.key}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: port.model, max_tokens: 1_000, stream: true, messages: [{ role: "user", content: "Say hello." }] }),
  });
  const text = await response.text();
  for (const end = Date.now() + 10_000; booked.length === 0; await new Promise((resolve) => setTimeout(resolve, 5))) {
    if (Date.now() > end) throw new Error(`nothing was booked; the client read ${response.status}: ${text.slice(0, 300)}`);
  }
  return { ...booked[0], status: response.status, text };
}

test("an OpenRouter model's request is booked at what OpenRouter charged, the list price beside it; the cap still holds it at list", async (t) => {
  const { fetch, asked } = upstream(answer({ cost: CHARGED_USD, is_byok: false }));
  const route = await routeOf(MODEL, OR_ALONE, "default", undefined, fetch);
  assert.deepEqual(capModelOf(route).price, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] }, "the cap's price is the list price");
  const { usage, ended } = await bookedOn(t, route);
  assert.deepEqual(asked, ["https://openrouter.ai/api/v1/chat/completions"]);
  assert.equal(usage.usd, CHARGED_USD, "the request is booked at OpenRouter's figure");
  assert.ok(Math.abs(usage.tableUsd - LIST_USD) < 1e-12, `the list price's figure beside it: ${usage.tableUsd}`);
  assert.equal(usage.estimated, undefined, "a figure the provider gave, not one made up here");
  assert.equal(ended.end, "answered");
  assert.equal(ended.usd, CHARGED_USD);
});

test("an OpenRouter answer with no cost in its usage is booked at the list price, as before", async (t) => {
  const { fetch } = upstream(answer({}));
  const { usage } = await bookedOn(t, await routeOf(MODEL, OR_ALONE, "default", undefined, fetch));
  assert.ok(Math.abs(usage.usd - LIST_USD) < 1e-12, `the list price: ${usage.usd}`);
  assert.equal(usage.tableUsd, undefined);
});

test("a workflow model node on OpenRouter books what OpenRouter charged too (its provider carries usageCost)", async () => {
  const route = await routeOf(MODEL, OR_ALONE, "default", undefined, upstream(answer({})).fetch);
  assert.equal((await providerFromRoute(route)).usageCost, true);
});

test("OpenRouter's routers have no price here: unpriced on every path, a cap's price unknown, and a capped run refused before it starts", async () => {
  const route = await routeOf(ROUTER, OR_ALONE, "default", undefined, upstream(answer({})).fetch);
  assert.equal(route.unpriced, true, "the route says it has no price");
  assert.equal(route.price("openrouter/auto", { input: 10_000, output: 500, cacheRead: 0, cacheWrite: 0 }), null, "never $0");
  assert.equal(capModelOf(route).price, null, "a pi turn's cap model: price unknown, never $0");
  assert.equal((await providerFromRoute(route)).capModel.price, null, "a workflow model node's cap model: price unknown, never its placeholder's $0");
  assert.ok((await runModels(OR_ALONE, ROUTER)).unpriced.has("openrouter/auto"));
  assert.deepEqual(await unpricedModels(OR_ALONE, ROUTER), ["openrouter/auto"]);
  assert.deepEqual(await unpricedModels(OR_ALONE, MODEL), [], "a priced OpenRouter model is not");
  const blockers = await blockersOf(OR_ALONE, { kind: "agentic", instructions: "Answer.", model: ROUTER }, {}, { capped: true });
  assert.ok(blockers.some((blocker) => blocker.unpriced && /openrouter\/auto has no price here/.test(blocker.message)), JSON.stringify(blockers));
  assert.deepEqual(await blockersOf(OR_ALONE, { kind: "agentic", instructions: "Answer.", model: ROUTER }, {}, { capped: false }), [], "with no cap it runs");
});

test("a router with no cap is booked at what OpenRouter said it cost, else unknown, never $0", async (t) => {
  const charged = await bookedOn(t, await routeOf(ROUTER, OR_ALONE, "default", undefined, upstream(answer({ cost: CHARGED_USD, is_byok: false })).fetch));
  assert.equal(charged.usage.usd, CHARGED_USD, "OpenRouter's figure");
  assert.equal(charged.usage.tableUsd, null, "no list price beside it");
  const silent = await bookedOn(t, await routeOf(ROUTER, OR_ALONE, "default", undefined, upstream(answer({})).fetch));
  assert.equal(silent.usage.usd, null, "no figure: unknown");
  assert.equal(silent.ended.usd, null);
});

test("a rate limit inside OpenRouter's 200 stream is booked as refused at $0, in the provider's words", async (t) => {
  const { usage, ended, text } = await bookedOn(t, await routeOf(MODEL, OR_ALONE, "default", undefined, upstream(limited()).fetch));
  assert.equal(usage.usd, 0);
  assert.equal(usage.estimated, undefined, "nothing was billed, as the provider said");
  assert.deepEqual(ended, { end: "nothing", label: "refused", reason: LIMITED });
  assert.match(text, /rate_limit_error/, "the client reads a rate limit, as Messages writes one");
  assert.match(text, /Rate limit exceeded: free-models-per-min/, "in the provider's words");
});
