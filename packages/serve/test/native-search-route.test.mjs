// A harness's own search runs only where its model requests go to its own provider. On OpenRouter (#1537's route:
// OPENROUTER_API_KEY alone, or a model named openrouter/<vendor>/...), OpenRouter runs no OpenAI hosted web_search for
// Codex and no Anthropic server search for Claude, and its answers carry no count of searches to price. Testers saw a
// Codex agent on auto that never searched, with every request unpriced. So on that route web_search's auto never picks
// the harness's own search (Parallel with its key, else keyless Exa), and native resolves unavailable, saying why.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { MODEL_KEYS } from "../dist/model.js";
import { explainsView, planeFor, resolveCapability } from "../dist/tool-plane.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { OPENROUTER_BASE, providerFor } from "../dist/provider.js";

const fake = (name) => ["not-a-secret", name].join("-");
const base = { gateway: false, parallelKey: false };
const search = (input) => resolveCapability("web_search", { ...base, ...input });

test("the resolver: on OpenRouter, auto never picks a harness's own search, and native says why it can't", () => {
  assert.equal(search({ harness: "codex", openRouter: true }), "exa-keyless", "codex on OpenRouter, auto: keyless Exa");
  assert.equal(search({ harness: "codex", openRouter: true, parallelKey: true }), "parallel", "codex on OpenRouter, auto, Parallel's key held");
  assert.equal(search({ harness: "codex", openRouter: true, override: "native" }), "unavailable: no native search for codex on OpenRouter");
  assert.equal(search({ harness: "claude-agent", openRouter: true, override: "native" }), "unavailable: no native search for claude-agent on OpenRouter");
  assert.equal(search({ harness: "claude-agent", openRouter: true }), "exa-keyless", "claude-agent's auto already skips its own search");
  // Off OpenRouter, unchanged.
  assert.equal(search({ harness: "codex" }), "native", "codex on OpenAI's own API keeps its own search");
  assert.equal(search({ harness: "claude-agent", override: "native" }), "native");
});

test("capabilities: on OPENROUTER_API_KEY alone codex's web_search resolves to keyless Exa (or Parallel), and native picked is unavailable with its reason", () => {
  const view = (env, settings = {}) => explainsView(env, settings).web_search;
  const or = view({ OPENROUTER_API_KEY: fake("or") });
  assert.equal(or.resolves.codex, "exa-keyless", or.why.codex);
  assert.notEqual(or.why.codex, "Codex's own search", "capabilities no longer claim Codex's own search");
  assert.match(or.why.codex, /OpenRouter.*not run.*keyless/, or.why.codex);
  assert.equal(view({ OPENROUTER_API_KEY: fake("or"), PARALLEL_API_KEY: fake("parallel") }).resolves.codex, "parallel");
  const native = view({ OPENROUTER_API_KEY: fake("or") }, { web_search: { provider: "native" } });
  assert.equal(native.resolves.codex, "unavailable: no native search for codex on OpenRouter");
  assert.equal(native.resolves["claude-agent"], "unavailable: no native search for claude-agent on OpenRouter");
  assert.match(native.why.codex, /OpenRouter/);
  // OpenAI's own key: Codex's own search, as before.
  assert.equal(view({ OPENAI_API_KEY: fake("openai") }).resolves.codex, "native");
});

test("a run's plane follows the route its model requests take, the one providerFor sends them on", () => {
  const plane = (env, model) => planeFor(env, { harness: "codex", tools: ["web_search"], ...(model ? { model } : {}) }, {}).web_search;
  const cases = [
    [{ OPENROUTER_API_KEY: fake("or") }, undefined],
    [{ OPENROUTER_API_KEY: fake("or") }, "openai/gpt-6-sol"],
    [{ OPENROUTER_API_KEY: fake("or"), OPENAI_API_KEY: fake("openai") }, "openrouter/openai/gpt-6-sol"],
    [{ OPENROUTER_API_KEY: fake("or"), OPENAI_API_KEY: fake("openai") }, "openai/gpt-6-sol"],
    [{ OPENAI_API_KEY: fake("openai") }, "openai/gpt-6-sol"],
  ];
  for (const [env, model] of cases) {
    const named = model ?? "openai/gpt-6-sol";
    const slash = named.indexOf("/");
    const ref = { provider: named.slice(0, slash), modelId: named.slice(slash + 1) };
    const viaOpenRouter = providerFor("openai-responses", env, ref, "codex").origin === OPENROUTER_BASE;
    assert.equal(plane(env, model), viaOpenRouter ? "exa-keyless" : "native", `${JSON.stringify(Object.keys(env))} ${named}: ${viaOpenRouter ? "OpenRouter" : "OpenAI"}`);
  }
});

const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", ...MODEL_KEYS.map((row) => row.field)];

test("a codex agent with web_search on OPENROUTER_API_KEY alone sends no hosted web_search tool, and its requests are priced", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  const gw = await startFauxGateway({ text: () => "42" });
  t.after(() => gw.close());
  // OpenRouter's route has no loopback setting by design: a preload in the run's processes sends openrouter.ai to the
  // faux gateway, which answers as OpenRouter does (no tool_usage count of searches).
  const hook = join(dir, "to-gateway.mjs");
  writeFileSync(hook, `const real = globalThis.fetch;
const gw = process.env.OR_TEST_GATEWAY;
if (gw && typeof real === "function") globalThis.fetch = (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== "https://openrouter.ai") return real(input, init);
  const there = gw + url.pathname + url.search;
  return input instanceof Request ? real(new Request(there, input), init) : real(there, init);
};
`);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), OPENROUTER_API_KEY: fake(`or-${randomBytes(6).toString("hex")}`), NODE_OPTIONS: `--import=file://${hook}`, OR_TEST_GATEWAY: gw.url }, [...MODEL_VARS, "NODE_OPTIONS", "OR_TEST_GATEWAY"]);
  const { api } = await serve(t, { faux: undefined });
  const offer = (await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "codex");
  assert.ok(offer?.available, `codex offered: ${JSON.stringify(offer)}`);
  assert.equal((await api("POST", "/agents", agent("searcher", { harness: "codex", tools: ["web_search"] }))).status, 201);
  const started = await api("POST", "/agents/searcher/runs", { input: { content: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 180_000 });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  const sent = gw.requests.filter((r) => r.method === "POST" && r.path.endsWith("/v1/responses"));
  assert.ok(sent.length > 0, "the run asked OpenRouter's Responses API");
  for (const request of sent) assert.ok(!(request.body?.tools ?? []).some((tool) => tool?.type === "web_search" || tool?.type === "web_search_preview"), `no hosted web_search tool sent: ${JSON.stringify(request.body?.tools?.map((tool) => tool?.type ?? tool?.name))}`);
  assert.equal(typeof view.cost?.usd, "number", `every request priced: ${JSON.stringify(view.cost)}`);
});
