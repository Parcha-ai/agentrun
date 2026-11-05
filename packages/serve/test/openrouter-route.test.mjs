// claude-agent and codex with OpenRouter as the only model source (OPENROUTER_API_KEY, no Anthropic or OpenAI key): each
// runs, its model requests go to OpenRouter's API (its Messages endpoint, its Responses API) with the key as a bearer
// token (claude-agent with Anthropic's own id on the wire, codex with the model's whole id), each has a default model
// there, and a claude-agent run is priced as OpenRouter bills it. A setting of the harness's own still
// wins: the endpoint the host names (ANTHROPIC_BASE_URL, AGENT_MODEL_BASE_URL), then the vendor's own key, then
// OpenRouter. The requests go through each adapter's real model proxy to a fake upstream (a fetch standing in for
// openrouter.ai); nothing leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "@parcha/agentrun-dsl";
import { createHarnessRunner } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { fakeAnthropic, fakeSdk } from "@parcha/agentrun-harness-claude/testing";
// The module whole, so a function it does not export yet fails its own test, not the file.
import * as adapters from "../dist/adapters.js";
import { agent, scratch, serve, withEnv } from "./support.mjs";

/** OpenRouter's key in these tests: no real one. */
const KEY = `not-a-secret-${"openrouter"}`;
const ONLY = { OPENROUTER_API_KEY: KEY };
const OWN = `not-a-secret-${"own"}`;
const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
/** Every variable that names a model source, unset for a test that sets only its own. */
const SOURCES = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY"];

const refused = (pattern) => (error) => error instanceof adapters.HarnessUnavailable && pattern.test(error.message);
/** A provider as the proxy uses it: where it sends, how the key goes, the key, and the model's id there. */
const view = (provider) => ({ origin: provider.origin, auth: provider.auth, key: provider.credential(), model: provider.modelId, priced: provider.priceModel });
const SCHEMAS = { Out: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } };
const doc = { v: 2, name: "route", schemas: SCHEMAS, output: { schemaId: "Out", path: "final" }, root: { node: "agent", label: "task", instructions: "Answer.", out: "Out", as: "final" } };
const SUBMIT = 'call submit {"value":{"answer":"ok"}}';

test("or-1: with only OPENROUTER_API_KEY, claude-agent's provider is OpenRouter's Messages endpoint: the key as a bearer token, Anthropic's own id on the wire, priced by OpenRouter's catalog entry", () => {
  const openrouter = { origin: "https://openrouter.ai/api", auth: "bearer", key: KEY, model: "claude-sonnet-5-5", priced: { provider: "openrouter", id: "anthropic/claude-sonnet-5.5" } };
  // OpenRouter's dotted name and Anthropic's own id are one model: Anthropic's id goes on the wire, as the CLI knows it.
  for (const modelId of ["claude-sonnet-5.5", "claude-sonnet-5-5"]) assert.deepEqual(view(adapters.claudeProvider(ONLY, { provider: "anthropic", modelId })), openrouter, modelId);
  assert.deepEqual(adapters.claudeProvider(ONLY, { provider: "anthropic", modelId: "claude-opus-5" }).priceModel, { provider: "openrouter", id: "anthropic/claude-opus-5" }, "a model with no point release keeps its name");
  // As a save and a run resolve it: OpenRouter's default for claude-agent, named as capabilities show it.
  assert.deepEqual(adapters.claudeModel(ONLY, undefined), { model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } });
  assert.deepEqual(adapters.claudeModel(ONLY, "anthropic/claude-sonnet-5.5"), { model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } });
  // pi's name for it (openrouter/anthropic/...) runs on claude-agent too, rather than being refused as two segments.
  const pis = adapters.claudeModel(ONLY, "openrouter/anthropic/claude-sonnet-5.5");
  assert.deepEqual(pis, { model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" } });
  assert.deepEqual(view(adapters.claudeProvider(ONLY, pis.model)), openrouter);
});

test("or-2: with only OPENROUTER_API_KEY, codex's provider is OpenRouter's Responses API with its key, the model's whole id on the wire, and no OpenAI key needed", async () => {
  const openrouter = { origin: "https://openrouter.ai/api", key: KEY, model: "openai/gpt-6-sol" };
  const codexView = (p) => ({ origin: p.origin, key: p.credential(), model: p.modelId });
  assert.deepEqual(codexView(adapters.codexProvider(ONLY, { provider: "openai", modelId: "gpt-6-sol" })), openrouter);
  assert.deepEqual(codexView(adapters.codexProvider(ONLY, { provider: "openrouter", modelId: "openai/gpt-6-sol" })), openrouter);
  // As a save and a run resolve it: OpenRouter's default for codex, OpenAI's model, priced by the catalog.
  assert.deepEqual(await adapters.codexModel(ONLY, undefined), { model: { provider: "openai", modelId: "gpt-6-sol" } });
  assert.deepEqual(await adapters.codexModel(ONLY, "openai/gpt-6.1-sol"), { model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  assert.deepEqual(await adapters.codexModel(ONLY, "openrouter/openai/gpt-6-sol"), { model: { provider: "openrouter", modelId: "openai/gpt-6-sol" } });
  assert.equal((await adapters.codexModel(ONLY, "openai/no-such-model")).needs, "model", "a model no catalog knows is still refused");
});

test("or-3: the harness's own settings win over OpenRouter, as on a host without its key: the endpoint the host names, then the vendor's own key; the OpenRouter key never goes to another endpoint", async () => {
  const anthropic = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
  assert.deepEqual(view(adapters.claudeProvider({ ...ONLY, ANTHROPIC_API_KEY: OWN }, anthropic)), { origin: "https://api.anthropic.com", auth: "x-api-key", key: OWN, model: "claude-sonnet-5-5", priced: { provider: "anthropic", id: "claude-sonnet-5-5" } });
  assert.deepEqual(view(adapters.claudeProvider({ ...ONLY, ANTHROPIC_API_KEY: OWN, ANTHROPIC_BASE_URL: "http://127.0.0.1:5000/" }, anthropic)), { origin: "http://127.0.0.1:5000", auth: "x-api-key", key: OWN, model: "claude-sonnet-5-5", priced: { provider: "anthropic", id: "claude-sonnet-5-5" } });
  assert.throws(() => adapters.claudeProvider({ ...ONLY, ANTHROPIC_BASE_URL: "http://127.0.0.1:5000" }, anthropic), (e) => e instanceof adapters.HarnessUnavailable && e.message === "claude-agent needs ANTHROPIC_API_KEY.", "an endpoint the host names, with no key of its own: refused as on main, never sent OpenRouter's");
  assert.deepEqual(adapters.claudeModel({ ...ONLY, ANTHROPIC_API_KEY: OWN }, "anthropic/claude-sonnet-5.5"), { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } }, "with Anthropic's key, Anthropic's own id");
  assert.deepEqual(adapters.claudeModel({ ...ONLY, ANTHROPIC_API_KEY: OWN }, undefined), { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } }, "and Anthropic's default: its key's row comes first");
  const openai = { provider: "openai", modelId: "gpt-6.1-sol" };
  const codexView = (p) => ({ origin: p.origin, key: p.credential(), model: p.modelId });
  assert.deepEqual(codexView(adapters.codexProvider({ ...ONLY, OPENAI_API_KEY: OWN }, openai)), { origin: "https://api.openai.com", key: OWN, model: "gpt-6.1-sol" });
  assert.deepEqual(codexView(adapters.codexProvider({ ...ONLY, AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000/v1" }, { provider: "agent-model", modelId: "openai/gpt-6-sol" })), { origin: "http://127.0.0.1:4000", key: "none", model: "openai/gpt-6-sol" }, "a gateway with no key of its own: none, never OpenRouter's");
  assert.deepEqual(await adapters.codexModel({ ...ONLY, OPENAI_API_KEY: OWN }, undefined), { model: { provider: "openai", modelId: "gpt-6.1-sol" } }, "with OpenAI's key, OpenAI's default");
  // A model the definition names on OpenRouter (pi's name) goes there whatever key is beside it, and needs its key.
  assert.equal(adapters.claudeProvider({ ...ONLY, ANTHROPIC_API_KEY: OWN }, { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }).origin, "https://openrouter.ai/api");
  assert.throws(() => adapters.claudeProvider({ ANTHROPIC_API_KEY: OWN }, { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }), refused(/OPENROUTER_API_KEY/));
  // Another vendor's model through OpenRouter is not the harness's.
  assert.throws(() => adapters.claudeProvider(ONLY, { provider: "openrouter", modelId: "openai/gpt-6-sol" }), refused(/claude-agent runs Anthropic models/));
  assert.throws(() => adapters.codexProvider(ONLY, { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }), refused(/codex runs OpenAI models/));
  // No source at all: each names every key that would do.
  assert.throws(() => adapters.claudeProvider({}, anthropic), refused(/ANTHROPIC_API_KEY.*OPENROUTER_API_KEY/));
  assert.throws(() => adapters.codexProvider({}, openai), refused(/OPENAI_API_KEY.*OPENROUTER_API_KEY/));
});

test("or-7: a claude-agent run through OpenRouter is priced by OpenRouter's catalog entry for the model, direct by Anthropic's, whichever pi-ai catalog is installed", async () => {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const real = await import("@parcha/agentrun-harness-claude");
  const catalog = builtinModels();
  // Every kind of token, each a different count, so a price names one entry's whole cost.
  const usage = { input: 1_000_000, output: 2_000_000, cacheRead: 3_000_000, cacheWrite: 4_000_000 };
  const priceOn = async (env, model) => {
    let price;
    await adapters.claudeOf(env, { model, models: catalog }, async () => ({ ...real, claudeAgentAdapter: (options) => ((price = options.price), { id: "claude-agent" }) }));
    return price("any", usage);
  };
  const atEntry = (provider, id) => {
    const cost = catalog.getModel(provider, id)?.cost;
    assert.ok(cost, `the installed catalog lists ${provider}/${id}`);
    return (usage.input * cost.input + usage.output * cost.output + usage.cacheRead * (cost.cacheRead ?? 0) + usage.cacheWrite * (cost.cacheWrite ?? 0)) / 1e6;
  };
  const [viaOpenRouter, direct] = [atEntry("openrouter", "anthropic/claude-sonnet-5.5"), atEntry("anthropic", "claude-sonnet-5-5")];
  assert.equal(await priceOn(ONLY, { provider: "anthropic", modelId: "claude-sonnet-5.5" }), viaOpenRouter, "OpenRouter's entry: OpenRouter bills it");
  assert.equal(await priceOn({ ANTHROPIC_API_KEY: OWN }, { provider: "anthropic", modelId: "claude-sonnet-5-5" }), direct, "Anthropic's entry");
  // The catalog this was written on (pi-ai's newest) lists cache reads at $0.10 through OpenRouter and $0.20 direct; the
  // consumer legs' older pi-ai (1.2, 1.3) lists both at $0.10, and the routes then cost the same.
  const cacheRead = (provider, id) => catalog.getModel(provider, id).cost.cacheRead;
  if (cacheRead("openrouter", "anthropic/claude-sonnet-5.5") === 0.1 && cacheRead("anthropic", "claude-sonnet-5-5") === 0.2) assert.notEqual(viaOpenRouter, direct);
});

test("or-8: no model here names OpenRouter's key first, and claude-agent's names it too; a direct provider's key still wins the default", async () => {
  const { ADD_A_KEY, hostModel } = await import("../dist/model.js");
  assert.equal(ADD_A_KEY, "add a model key in Settings → Model keys, or set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY where AgentRun starts.");
  assert.equal(adapters.claudeModel({}, undefined).why, "No model yet for claude-agent: add an OpenRouter or Anthropic key in Settings → Model keys, or set OPENROUTER_API_KEY or ANTHROPIC_API_KEY where AgentRun starts.");
  // OpenRouter alone: a default for every harness.
  assert.deepEqual(["pi", "claude-agent", "codex"].map((h) => hostModel(ONLY, "default", h)), ["openrouter/openai/gpt-6-sol", "anthropic/claude-sonnet-5.5", "openai/gpt-6-sol"]);
  // Beside Anthropic's key: Anthropic's for pi and claude-agent, OpenRouter's for codex.
  assert.deepEqual(["pi", "claude-agent", "codex"].map((h) => hostModel({ ...ONLY, ANTHROPIC_API_KEY: OWN }, "default", h)), ["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"]);
});

test("or-4: claude-agent on OpenRouter alone: each request through its proxy to https://openrouter.ai/api/v1/messages, the key as a bearer token and no x-api-key, Anthropic's own id on the wire", { timeout: 60_000 }, async (t) => {
  process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = "1";
  const messages = await fakeAnthropic({ reply: () => ({ text: "ok" }) });
  t.after(() => messages.close());
  const seen = [];
  // openrouter.ai, here: each request the proxy sends is recorded, then answered by a fake Messages endpoint.
  const upstream = async (url, init) => {
    const headers = new Headers(init.headers);
    seen.push({ url: String(url), authorization: headers.get("authorization"), apiKey: headers.has("x-api-key"), model: JSON.parse(init.body).model });
    const { pathname, search } = new URL(url);
    return fetch(`${messages.url}${pathname.replace(/^\/api/, "")}${search}`, init);
  };
  const real = await import("@parcha/agentrun-harness-claude");
  const sessions = join(await scratch(t), "sessions");
  const sdk = fakeSdk({ remoteModel: true, script: [SUBMIT] });
  const load = async () => ({ ...real, claudeAgentAdapter: (options) => real.claudeAgentAdapter({ ...options, sdk, standIn: { command: process.execPath }, sessionsDir: sessions, fetch: upstream }) });
  const chosen = adapters.claudeModel(ONLY, "anthropic/claude-sonnet-5.5");
  assert.ok("model" in chosen, JSON.stringify(chosen));
  const adapter = await adapters.claudeOf(ONLY, { model: chosen.model, models: { getModel: () => undefined } }, load);
  const result = await runWorkflow(doc, {}, { runNode: createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] }) });
  assert.equal(result.status, "complete", JSON.stringify(result.error ?? null));
  assert.ok(seen.length >= 1, "a model request reached OpenRouter");
  for (const request of seen) assert.deepEqual(request, { url: "https://openrouter.ai/api/v1/messages?beta=true", authorization: `Bearer ${KEY}`, apiKey: false, model: "claude-sonnet-5-5" });
});

test("or-5: codex on OpenRouter alone: each request through its proxy to https://openrouter.ai/api/v1/responses, the key as a bearer token, the model OpenRouter's whole slug", { timeout: 60_000 }, async (t) => {
  process.env.AGENTRUN_CODEX_STANDIN = "1";
  const seen = [];
  const upstream = async (url, init) => {
    const headers = new Headers(init.headers);
    seen.push({ url: String(url), authorization: headers.get("authorization"), model: JSON.parse(init.body).model });
    const events = [{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 3 } } }];
    return new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const dir = await scratch(t);
  const script = join(dir, "script.json");
  await writeFile(script, JSON.stringify([SUBMIT]));
  const env = { ...ONLY, AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [STAND_IN], env: { FAKE_CODEX_MODEL: "remote", FAKE_CODEX_SCRIPT: script } }) };
  const real = await import("@parcha/agentrun-harness-codex");
  const load = async () => ({ ...real, codexAdapter: (options) => real.codexAdapter({ ...options, sessionsDir: join(dir, "sessions"), fetch: upstream }) });
  const chosen = await adapters.codexModel(env, undefined);
  assert.ok("model" in chosen, JSON.stringify(chosen));
  const adapter = await adapters.codexOf(env, { model: chosen.model, models: { getModel: () => undefined } }, load);
  const result = await runWorkflow(doc, {}, { runNode: createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] }) });
  assert.equal(result.status, "complete", JSON.stringify(result.error ?? null));
  assert.ok(seen.length >= 1, "a model request reached OpenRouter");
  for (const request of seen) assert.deepEqual(request, { url: "https://openrouter.ai/api/v1/responses", authorization: `Bearer ${KEY}`, model: "openai/gpt-6-sol" });
});

test("or-6: a server with only OPENROUTER_API_KEY runs every harness, each with its default model on OpenRouter, and a definition naming Anthropic's or OpenAI's model saves with no warning", { timeout: 60_000 }, async (t) => {
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  // No request leaves the test: capabilities and saves check the harnesses, they never call a model.
  withEnv(t, { ...ONLY, AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }) }, SOURCES);
  const { api } = await serve(t, { faux: undefined });
  const harnesses = (await api("GET", "/capabilities")).body.harnesses;
  // How many fit at once is this host's memory (admission.test.mjs); the memory a run takes is the harness's own.
  const row = (id) => { const { max_concurrent_runs, ...offer } = harnesses.find((h) => h.id === id); return offer; };
  assert.deepEqual(row("pi"), { id: "pi", available: true, steer: true, default_model: "openrouter/openai/gpt-6-sol", run_memory_mib: 128 });
  assert.deepEqual(row("claude-agent"), { id: "claude-agent", available: true, steer: false, default_model: "anthropic/claude-sonnet-5.5", run_memory_mib: 288 });
  assert.deepEqual(row("codex"), { id: "codex", available: true, steer: false, default_model: "openai/gpt-6-sol", run_memory_mib: 192 });
  for (const [id, definition] of [
    ["claude", { harness: "claude-agent", model: "anthropic/claude-sonnet-5.5" }],
    ["claude-default", { harness: "claude-agent" }],
    ["coder", { harness: "codex", model: "openai/gpt-6-sol" }],
    ["pi-default", {}],
    ["coder-default", { harness: "codex" }],
  ]) {
    const saved = await api("POST", "/agents", agent(id, definition));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.warnings ?? [], [], `${id}: ${JSON.stringify(saved.body.warnings)}`);
  }
});

test("or-9: on OpenRouter's key alone, the host's AGENT_MODEL named on OpenRouter is the model claude-agent and codex run, not their key's default; Anthropic's native id on claude-agent's wire", async () => {
  const claudeHost = { ...ONLY, AGENT_MODEL: "openrouter/anthropic/claude-haiku-5.5" };
  const { hostModel } = await import("../dist/model.js");
  assert.equal(hostModel(claudeHost, "default", "claude-agent"), "openrouter/anthropic/claude-haiku-5.5", "the host's model, not OpenRouter's Sonnet default");
  const claude = adapters.claudeModel(claudeHost, undefined);
  assert.deepEqual(claude, { model: { provider: "openrouter", modelId: "anthropic/claude-haiku-5.5" } });
  assert.deepEqual(view(adapters.claudeProvider(claudeHost, claude.model)), { origin: "https://openrouter.ai/api", auth: "bearer", key: KEY, model: "claude-haiku-5-5", priced: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" } });
  const codexHost = { ...ONLY, AGENT_MODEL: "openrouter/openai/gpt-6.1-sol" };
  assert.equal(hostModel(codexHost, "default", "codex"), "openrouter/openai/gpt-6.1-sol", "the host's model, not OpenRouter's GPT-6 Sol default");
  assert.deepEqual(await adapters.codexModel(codexHost, undefined), { model: { provider: "openrouter", modelId: "openai/gpt-6.1-sol" } });
  // Another vendor's model on OpenRouter is not the harness's: it takes its own default, as before.
  assert.equal(hostModel(codexHost, "default", "claude-agent"), "anthropic/claude-sonnet-5.5");
  assert.equal(hostModel(claudeHost, "default", "codex"), "openai/gpt-6-sol");
});

test("or-10: a server on OpenRouter's key alone names the host's OpenRouter model as each harness's default, and a revision naming one there saves clean and runs it", { timeout: 60_000 }, async (t) => {
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  withEnv(t, { ...ONLY, AGENT_MODEL: "openrouter/anthropic/claude-haiku-5.5", AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }) }, SOURCES);
  const { api } = await serve(t, { faux: undefined });
  const harnesses = (await api("GET", "/capabilities")).body.harnesses;
  assert.equal(harnesses.find((h) => h.id === "claude-agent").default_model, "openrouter/anthropic/claude-haiku-5.5");
  assert.equal(harnesses.find((h) => h.id === "codex").default_model, "openai/gpt-6-sol", "an Anthropic model is not codex's: its own default");
  for (const [id, definition] of [["claude-or", { harness: "claude-agent", model: "openrouter/anthropic/claude-opus-5" }], ["codex-or", { harness: "codex", model: "openrouter/openai/gpt-6.1-sol" }]]) {
    const saved = await api("POST", "/agents", agent(id, definition));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.warnings ?? [], [], `${id}: ${JSON.stringify(saved.body.warnings)}`);
  }
});

test("or-11: claude-agent on the host's OpenRouter model sends Anthropic's native id for it through OpenRouter", { timeout: 60_000 }, async (t) => {
  process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = "1";
  const host = { ...ONLY, AGENT_MODEL: "openrouter/anthropic/claude-haiku-5.5" };
  const messages = await fakeAnthropic({ reply: () => ({ text: "ok" }) });
  t.after(() => messages.close());
  const seen = [];
  const upstream = async (url, init) => {
    seen.push({ url: String(url), model: JSON.parse(init.body).model });
    const { pathname, search } = new URL(url);
    return fetch(`${messages.url}${pathname.replace(/^\/api/, "")}${search}`, init);
  };
  const real = await import("@parcha/agentrun-harness-claude");
  const sessions = join(await scratch(t), "sessions");
  const sdk = fakeSdk({ remoteModel: true, script: [SUBMIT] });
  const load = async () => ({ ...real, claudeAgentAdapter: (options) => real.claudeAgentAdapter({ ...options, sdk, standIn: { command: process.execPath }, sessionsDir: sessions, fetch: upstream }) });
  const chosen = adapters.claudeModel(host, undefined);
  const adapter = await adapters.claudeOf(host, { model: chosen.model, models: { getModel: () => undefined } }, load);
  const result = await runWorkflow(doc, {}, { runNode: createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] }) });
  assert.equal(result.status, "complete", JSON.stringify(result.error ?? null));
  assert.ok(seen.length >= 1);
  for (const request of seen) assert.deepEqual(request, { url: "https://openrouter.ai/api/v1/messages?beta=true", model: "claude-haiku-5-5" });
});

test("opencode on OpenRouter's key alone has codex's default there, and codexModel and codexProvider give it OpenAI's model on OpenRouter's Responses API with the model's whole id", async () => {
  const { hostModel, MODEL_KEYS } = await import("../dist/model.js");
  assert.equal(hostModel(ONLY, "default", "opencode"), "openai/gpt-6-sol", "codex's default on OpenRouter");
  assert.deepEqual(MODEL_KEYS.find((row) => row.id === "openrouter").harnesses, ["pi", "claude-agent", "codex", "opencode"]);
  assert.equal(hostModel({ ...ONLY, OPENAI_API_KEY: OWN }, "default", "opencode"), "openai/gpt-6.1-sol", "OpenAI's own key wins");
  assert.deepEqual(await adapters.codexModel(ONLY, undefined, "opencode"), { model: { provider: "openai", modelId: "gpt-6-sol" } });
  assert.deepEqual(await adapters.codexModel(ONLY, "openrouter/openai/gpt-6-sol", "opencode"), { model: { provider: "openrouter", modelId: "openai/gpt-6-sol" } });
  const p = adapters.codexProvider(ONLY, { provider: "openai", modelId: "gpt-6-sol" }, "opencode");
  assert.deepEqual({ origin: p.origin, key: p.credential(), model: p.modelId }, { origin: "https://openrouter.ai/api", key: KEY, model: "openai/gpt-6-sol" });
  assert.throws(() => adapters.codexProvider({}, { provider: "openai", modelId: "gpt-6-sol" }, "opencode"), refused(/^opencode needs OPENAI_API_KEY, OPENROUTER_API_KEY/));
});

test("a key refused on an opencode run that reaches OpenAI's model through OpenRouter is named as OpenRouter's, as codex's is", async () => {
  const { runKeyOf } = await import("../dist/key-refusal.js");
  assert.deepEqual(runKeyOf(ONLY, "opencode", "openai/gpt-6-sol"), runKeyOf(ONLY, "codex", "openai/gpt-6-sol"), "codex's key on the same route");
  assert.deepEqual(runKeyOf(ONLY, "opencode", "openai/gpt-6-sol"), { who: "OpenRouter", field: "OPENROUTER_API_KEY", saved: true });
  assert.deepEqual(runKeyOf(ONLY, "opencode"), { who: "OpenRouter", field: "OPENROUTER_API_KEY", saved: true }, "on its default there");
  assert.deepEqual(runKeyOf({ OPENAI_API_KEY: OWN }, "opencode"), { who: "OpenAI", field: "OPENAI_API_KEY", saved: true });
});
