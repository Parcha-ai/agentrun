// A learned workflow's model requests on claude-agent and codex take the harness's own route (adapters.ts learnedRoute):
// on OPENROUTER_API_KEY alone, OpenRouter's name for the run's model, which the catalog lists and prices and whose key
// the run holds, never the vendor's provider (whose key the run does not have, and whose catalog has no dotted name).
// OpenRouter is the faux gateway here: every request to openrouter.ai goes to it, and one anywhere else off loopback is
// refused. The requests go through `completer` and the run's models as app.ts builds them (builtinModels on the run's env).
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as adapters from "../dist/adapters.js";
import { completer } from "../dist/llm.js";
import { authContextOf } from "../dist/secrets.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

/** Dummy keys: not real ones. */
const KEY = "not-a-secret-openrouter";
const ANTHROPIC = "not-a-secret-anthropic";
const OPENAI = "not-a-secret-openai";

/** While `t` runs, a request to openrouter.ai goes to `gateway` instead (same path and query), one to loopback goes as
 *  it is, and any other is refused before it is sent and listed. */
function openRouterAt(t, gateway) {
  const real = globalThis.fetch;
  const refused = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return real(input, init);
    if (url.hostname === "openrouter.ai") return real(`${gateway}${url.pathname}${url.search}`, input instanceof Request ? input : init);
    refused.push(url.origin);
    return Promise.reject(new Error(`this test sends nothing to ${url.origin}`));
  };
  t.after(() => (globalThis.fetch = real));
  return refused;
}

test("on OPENROUTER_API_KEY alone, a claude-agent or codex run's learned workflow asks its model through OpenRouter, with OpenRouter's key, by OpenRouter's name for the run's model", { timeout: 60_000 }, async (t) => {
  assert.equal(typeof adapters.learnedRoute, "function", "adapters.ts exports learnedRoute");
  const gw = await startFauxGateway({ text: "the answer" });
  t.after(() => gw.close());
  const refused = openRouterAt(t, gw.url);
  const env = { OPENROUTER_API_KEY: KEY };
  const models = builtinModels({ authContext: authContextOf(env) });
  const claude = adapters.claudeModel(env, "anthropic/claude-sonnet-5.5");
  const codex = await adapters.codexModel(env, "openai/gpt-6-sol");
  const cases = [
    // OpenRouter's Messages endpoint takes its key as pi-ai's OpenRouter entry for Claude sends it (as a pi run on the same
    // model does); its Chat Completions endpoint as a bearer token.
    ["claude-agent", claude.model, { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }, "/api/v1/messages", (h) => h["x-api-key"]],
    ["codex", codex.model, { provider: "openrouter", modelId: "openai/gpt-6-sol" }, "/api/v1/chat/completions", (h) => h.authorization?.replace(/^Bearer /, "")],
  ];
  for (const [harness, model, routed, path, keyOf] of cases) {
    const ref = adapters.learnedRoute(harness, env, model);
    assert.deepEqual(ref, routed, harness);
    assert.ok(models.getModel(ref.provider, ref.modelId)?.cost, `${harness}: the catalog lists and prices ${ref.provider}/${ref.modelId}`);
    const answer = await completer(models, () => ref, "off")({ prompt: "Say the answer." }, new AbortController().signal);
    assert.match(JSON.stringify(answer), /the answer/, `${harness}: answered`);
    const sent = gw.requests.at(-1);
    assert.deepEqual([sent.method, sent.path, keyOf(sent.headers), sent.body?.model], ["POST", path, KEY, routed.modelId], harness);
  }
  assert.deepEqual(refused, [], "nothing went anywhere but OpenRouter and loopback");
});

test("where the harness has its own key, a learned workflow's model is the run's model as it is", async () => {
  const claudeEnv = { OPENROUTER_API_KEY: KEY, ANTHROPIC_API_KEY: ANTHROPIC };
  const claude = adapters.claudeModel(claudeEnv, "anthropic/claude-sonnet-5.5");
  assert.deepEqual(adapters.learnedRoute("claude-agent", claudeEnv, claude.model), { provider: "anthropic", modelId: "claude-sonnet-5-5" });
  const codexEnv = { OPENROUTER_API_KEY: KEY, OPENAI_API_KEY: OPENAI };
  const codex = await adapters.codexModel(codexEnv, "openai/gpt-6-sol");
  assert.deepEqual(adapters.learnedRoute("codex", codexEnv, codex.model), codex.model);
  // A model the run names on OpenRouter (pi's name) is OpenRouter's already.
  const named = adapters.claudeModel(claudeEnv, "openrouter/anthropic/claude-sonnet-5.5");
  assert.deepEqual(adapters.learnedRoute("claude-agent", claudeEnv, named.model), { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" });
});

test("a codex run through a gateway at OpenRouter's URL (AGENT_MODEL_BASE_URL) keeps the gateway's model for its learned workflow: the run's models hold that provider, not OpenRouter's", () => {
  const env = { AGENT_MODEL_BASE_URL: "https://openrouter.ai/api/v1", AGENT_MODEL_API_KEY: KEY };
  const prepared = { provider: "agent-model", modelId: "openai/gpt-6-sol" };
  assert.deepEqual(adapters.learnedRoute("codex", env, prepared), prepared);
});

test("claude-agent through the operator's own gateway (ANTHROPIC_BASE_URL) is not offered learned workflows, whose requests could not follow it; on Anthropic or OpenRouter it is", async () => {
  const model = "anthropic/claude-sonnet-5.5";
  const gateway = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/anthropic", ANTHROPIC_API_KEY: ANTHROPIC };
  assert.match(await adapters.learnedWorkflowsOff("claude-agent", gateway, model) ?? "", /ANTHROPIC_BASE_URL/);
  assert.equal(await adapters.learnedWorkflowsOff("claude-agent", { ANTHROPIC_API_KEY: ANTHROPIC }, model), undefined);
  assert.equal(await adapters.learnedWorkflowsOff("claude-agent", { OPENROUTER_API_KEY: KEY }, model), undefined);
  // codex goes through its gateway on the run's models (runModels), and pi through its own: neither is turned off.
  assert.equal(await adapters.learnedWorkflowsOff("codex", { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL_API_KEY: KEY }, "openai/gpt-6-sol"), undefined);
  assert.equal(await adapters.learnedWorkflowsOff("pi", gateway, model), undefined);
});

test("an opencode run, on codex's route, names its learned workflow's model as codex's does: on OpenRouter alone, OpenRouter's name for it", async () => {
  const env = { OPENROUTER_API_KEY: KEY };
  const opencode = await adapters.codexModel(env, "openai/gpt-6-sol", "opencode");
  assert.deepEqual(adapters.learnedRoute("opencode", env, opencode.model), { provider: "openrouter", modelId: "openai/gpt-6-sol" });
  const own = { OPENROUTER_API_KEY: KEY, OPENAI_API_KEY: OPENAI };
  const direct = await adapters.codexModel(own, "openai/gpt-6-sol", "opencode");
  assert.deepEqual(adapters.learnedRoute("opencode", own, direct.model), direct.model);
});

test("a learned workflow follows its harness only to an origin its requests can reach: Anthropic, OpenAI, OpenRouter, or codex's and opencode's gateway; any other fails closed", async () => {
  for (const harness of ["claude-agent", "codex", "opencode"]) {
    assert.equal(adapters.learnedOriginOk(harness, "https://openrouter.ai/api", {}), true, harness);
    assert.equal(adapters.learnedOriginOk(harness, "https://elsewhere.example", {}), false, harness);
  }
  assert.equal(adapters.learnedOriginOk("claude-agent", "https://api.anthropic.com", {}), true);
  assert.equal(adapters.learnedOriginOk("codex", "https://api.openai.com", {}), true);
  assert.equal(adapters.learnedOriginOk("opencode", "https://api.openai.com", {}), true);
  // A gateway is the run's models' own for codex and opencode (runModels), never for claude-agent.
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1" };
  assert.equal(adapters.learnedOriginOk("opencode", "http://127.0.0.1:9", gateway), true);
  assert.equal(adapters.learnedOriginOk("claude-agent", "http://127.0.0.1:9", gateway), false);
  // opencode on OpenRouter alone, on OpenAI, through a gateway: offered.
  assert.equal(await adapters.learnedWorkflowsOff("opencode", { OPENROUTER_API_KEY: KEY }, "openai/gpt-6-sol"), undefined);
  assert.equal(await adapters.learnedWorkflowsOff("opencode", { OPENAI_API_KEY: OPENAI }, "openai/gpt-6-sol"), undefined);
  assert.equal(await adapters.learnedWorkflowsOff("opencode", { ...gateway, AGENT_MODEL_API_KEY: KEY }, "openai/gpt-6-sol"), undefined);
});

test("claude-agent through a gateway at OpenRouter's URL (ANTHROPIC_BASE_URL, the gateway's key in ANTHROPIC_API_KEY) is offered no learned workflow: its run holds no OpenRouter key, so its learned nodes could not follow the gateway", async () => {
  const env = { ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1", ANTHROPIC_API_KEY: ANTHROPIC };
  assert.match(await adapters.learnedWorkflowsOff("claude-agent", env, "anthropic/claude-sonnet-5.5") ?? "", /ANTHROPIC_BASE_URL/);
});
