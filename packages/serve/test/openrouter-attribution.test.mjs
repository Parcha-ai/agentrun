// AgentRun's OpenRouter app attribution (kernel host/openrouter-attribution.ts) on the runner's model route
// (runner/model-route.ts messagesFetch), where pi-ai sends a model's requests itself: a request to OpenRouter carries
// HTTP-Referer, X-OpenRouter-Title and X-OpenRouter-Categories, never X-OpenRouter-App-Visibility; with
// AGENTRUN_OPENROUTER_ATTRIBUTION=off it carries none; a request to another provider (OpenAI on its own key) carries none.
// And the Decisions providers on OpenRouter this server builds (decisions.ts) carry the same app, or none when off.
// The model proxy's side is the kernel's test (run-adapters test/proxy-openrouter-attribution.test.mjs). No network: the
// provider is a fetch that keeps what it was sent.
import assert from "node:assert/strict";
import { test } from "node:test";

const { routeOf } = await import("../dist/runner/model-route.js");

const KEY = `not-a-secret-${"route-key"}`;
const NAMES = ["http-referer", "x-openrouter-title", "x-openrouter-categories", "x-openrouter-app-visibility", "x-title"];
const ATTRIBUTED = { "http-referer": "https://github.com/Parcha-ai/agentrun", "x-openrouter-title": "AgentRun", "x-openrouter-categories": "cloud-agent,personal-agent" };

/** The attribution headers pi-ai sent the provider for one request on `model`'s route under `env`: the route's upstream
 *  keeps them and answers a refusal, so nothing goes on. Any other fetch throws (no test reaches a real provider). */
async function sentFor(model, env) {
  const sent = [];
  const upstream = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    sent.push({ url: String(url), headers: Object.fromEntries(NAMES.flatMap((name) => (headers.has(name) ? [[name, headers.get(name)]] : []))) });
    return new Response(JSON.stringify({ error: { message: "kept, not answered" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`a real fetch of ${String(url)}`); };
  try {
    const route = await routeOf(model, env, "default", undefined, upstream);
    assert.equal(typeof route.fetch, "function", `${model} answers through the route's translation`);
    const body = { model: "route", max_tokens: 64, stream: true, messages: [{ role: "user", content: "Say hi." }] };
    const response = await route.fetch(`${route.provider.origin}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await response.text();
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent.length, 1, `one request to the provider: ${JSON.stringify(sent.map((each) => each.url))}`);
  return sent[0];
}

for (const model of ["openrouter/inclusionai/ling-3.2-flash:free", "openrouter/openai/gpt-6.1-sol"]) {
  test(`pi on OpenRouter (${model}): the request carries AgentRun's attribution, and no visibility header`, async () => {
    const { url, headers } = await sentFor(model, { OPENROUTER_API_KEY: KEY });
    assert.equal(new URL(url).hostname, "openrouter.ai");
    assert.deepEqual(headers, ATTRIBUTED);
  });
}

for (const off of ["off", "OFF", " off "]) {
  test(`AGENTRUN_OPENROUTER_ATTRIBUTION=${JSON.stringify(off)}: a request to OpenRouter carries no attribution`, async () => {
    const { url, headers } = await sentFor("openrouter/inclusionai/ling-3.2-flash:free", { OPENROUTER_API_KEY: KEY, AGENTRUN_OPENROUTER_ATTRIBUTION: off });
    assert.equal(new URL(url).hostname, "openrouter.ai");
    assert.deepEqual(headers, {});
  });
}

test("AGENTRUN_OPENROUTER_ATTRIBUTION set to anything but off leaves attribution on", async () => {
  const { headers } = await sentFor("openrouter/inclusionai/ling-3.2-flash:free", { OPENROUTER_API_KEY: KEY, AGENTRUN_OPENROUTER_ATTRIBUTION: "on" });
  assert.deepEqual(headers, ATTRIBUTED);
});

/** The attribution headers each Decisions provider on OpenRouter (OpenRouter's own models, Parallel's through OpenRouter)
 *  that this server builds from `env` sent, keyed by provider. */
async function decisionsSent(env) {
  const { decisionProvidersIn, FAUX_OPENROUTER_ENV } = await import("../dist/decisions.js");
  const { FAUX_ENV } = await import("../dist/model.js");
  const { judgeFromProvider } = await import("@parcha/agentrun-dsl");
  const registry = await decisionProvidersIn({ [FAUX_ENV]: "1", [FAUX_OPENROUTER_ENV]: new URL("./fixtures/faux-openrouter-app.mjs", import.meta.url).pathname, OPENROUTER_API_KEY: KEY, ...env });
  const out = {};
  for (const [id, model] of [["openrouter", "liquid/d1"], ["parallel", registry.providers.parallel.capabilities.models[0]]]) {
    globalThis.__fauxOpenRouterHeaders = [];
    await judgeFromProvider(registry.providers[id])({ label: "x", kind: "judge", model, state: { claim: "c" }, questions: { holds: { type: "noul", instructions: "Does it hold?" } } });
    assert.equal(globalThis.__fauxOpenRouterHeaders.length, 1, id);
    const headers = globalThis.__fauxOpenRouterHeaders[0].headers;
    out[id] = Object.fromEntries(NAMES.flatMap((name) => (headers.has(name) ? [[name, headers.get(name)]] : [])));
  }
  return out;
}

test("Decisions on OpenRouter (its own models, Parallel's through it): this server hands the provider AgentRun's app; off hands none", async () => {
  assert.deepEqual(await decisionsSent({}), { openrouter: ATTRIBUTED, parallel: ATTRIBUTED });
  assert.deepEqual(await decisionsSent({ AGENTRUN_OPENROUTER_ATTRIBUTION: "off" }), { openrouter: {}, parallel: {} });
});

test("OpenAI on its own key, through the same translation: no attribution header", async () => {
  const { url, headers } = await sentFor("openai/gpt-6.1-sol", { OPENAI_API_KEY: KEY });
  assert.equal(new URL(url).hostname, "api.openai.com");
  assert.deepEqual(headers, {});
});
