// claude-agent and codex with OpenRouter as the only model source (OPENROUTER_API_KEY, no Anthropic or OpenAI key): each
// runs, its model requests go to OpenRouter's API (its Messages endpoint, its Responses API) with the key as a bearer
// token and the model as OpenRouter names it, and each has a default model there. A setting of the harness's own still
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
const view = (provider) => ({ origin: provider.origin, auth: provider.auth, key: provider.credential(), model: provider.modelId });
const SCHEMAS = { Out: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } };
const doc = { v: 2, name: "route", schemas: SCHEMAS, output: { schemaId: "Out", path: "final" }, root: { node: "agent", label: "task", instructions: "Answer.", out: "Out", as: "final" } };
const SUBMIT = 'call submit {"value":{"answer":"ok"}}';

test("or-1: with only OPENROUTER_API_KEY, claude-agent's provider is OpenRouter's Messages endpoint, the key as a bearer token and the model as OpenRouter names it", () => {
  const openrouter = { origin: "https://openrouter.ai/api", auth: "bearer", key: KEY, model: "anthropic/claude-sonnet-5.5" };
  // Anthropic's own id and OpenRouter's dotted name are one model, sent as OpenRouter's slug.
  for (const modelId of ["claude-sonnet-5-5", "claude-sonnet-5.5"]) assert.deepEqual(view(adapters.claudeProvider(ONLY, { provider: "anthropic", modelId })), openrouter, modelId);
  assert.equal(adapters.claudeProvider(ONLY, { provider: "anthropic", modelId: "claude-opus-5" }).modelId, "anthropic/claude-opus-5", "a model with no point release keeps its name");
  assert.equal(adapters.claudeProvider(ONLY, { provider: "anthropic", modelId: "claude-haiku-4-5" }).modelId, "anthropic/claude-haiku-4.5");
  // As a save and a run resolve it: Anthropic's model through OpenRouter, which OpenRouter's catalog entry prices.
  const through = { model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" } };
  assert.deepEqual(adapters.claudeModel(ONLY, "anthropic/claude-sonnet-5.5"), through);
  assert.deepEqual(adapters.claudeModel(ONLY, "anthropic/claude-sonnet-5-5"), through, "Anthropic's own id names the same model");
  // pi's name for it (the README's AGENT_MODEL) runs on claude-agent too, rather than being refused as two segments.
  assert.deepEqual(adapters.claudeModel(ONLY, "openrouter/anthropic/claude-sonnet-5.5"), through);
  assert.deepEqual(adapters.claudeModel({ ...ONLY, AGENT_MODEL: "openrouter/anthropic/claude-sonnet-5.5" }, undefined), through, "as the host's default too");
  assert.deepEqual(view(adapters.claudeProvider(ONLY, through.model)), openrouter);
});

test("or-2: with only OPENROUTER_API_KEY, codex's provider is OpenRouter's Responses API, the key as a bearer token and the model as OpenRouter's whole slug", async () => {
  const openrouter = { origin: "https://openrouter.ai/api", auth: "bearer", key: KEY, model: "openai/gpt-6.1-sol" };
  assert.deepEqual(view(adapters.codexProvider(ONLY, { provider: "openai", modelId: "gpt-6.1-sol" })), openrouter);
  assert.deepEqual(view(adapters.codexProvider(ONLY, { provider: "openrouter", modelId: "openai/gpt-6.1-sol" })), openrouter);
  // As a save and a run resolve it: OpenRouter's entry for the model, unlocked by OpenRouter's key, never refused for
  // want of OpenAI's.
  const through = { model: { provider: "openrouter", modelId: "openai/gpt-6.1-sol" } };
  assert.deepEqual(await adapters.codexModel(ONLY, "openai/gpt-6.1-sol"), through);
  assert.deepEqual(await adapters.codexModel(ONLY, "openrouter/openai/gpt-6.1-sol"), through);
  assert.deepEqual(await adapters.codexModel({ ...ONLY, AGENT_MODEL: "openai/gpt-6.1-sol" }, undefined), through, "as the host's default too");
});

test("or-3: the harness's own settings still win over OpenRouter: the endpoint the host names, then the vendor's own key; the OpenRouter key never goes to another endpoint", async () => {
  const anthropic = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
  assert.deepEqual(view(adapters.claudeProvider({ ...ONLY, ANTHROPIC_API_KEY: OWN }, anthropic)), { origin: "https://api.anthropic.com", auth: "x-api-key", key: OWN, model: "claude-sonnet-5-5" });
  assert.deepEqual(view(adapters.claudeProvider({ ...ONLY, ANTHROPIC_API_KEY: OWN, ANTHROPIC_BASE_URL: "http://127.0.0.1:5000/" }, anthropic)), { origin: "http://127.0.0.1:5000", auth: "x-api-key", key: OWN, model: "claude-sonnet-5-5" });
  assert.throws(() => adapters.claudeProvider({ ...ONLY, ANTHROPIC_BASE_URL: "http://127.0.0.1:5000" }, anthropic), refused(/ANTHROPIC_API_KEY/), "an endpoint the host names, with no key of its own: refused, never sent OpenRouter's");
  assert.deepEqual(adapters.claudeModel({ ...ONLY, ANTHROPIC_API_KEY: OWN }, "anthropic/claude-sonnet-5.5"), { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } }, "with Anthropic's key, Anthropic's model");
  const openai = { provider: "openai", modelId: "gpt-6.1-sol" };
  assert.deepEqual(view(adapters.codexProvider({ ...ONLY, OPENAI_API_KEY: OWN }, openai)), { origin: "https://api.openai.com", auth: "bearer", key: OWN, model: "gpt-6.1-sol" });
  assert.deepEqual(view(adapters.codexProvider({ ...ONLY, AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000/v1", AGENT_MODEL_API_KEY: OWN }, { provider: "agent-model", modelId: "openai/gpt-6.1-sol" })), { origin: "http://127.0.0.1:4000", auth: "bearer", key: OWN, model: "openai/gpt-6.1-sol" });
  assert.deepEqual(await adapters.codexModel({ ...ONLY, OPENAI_API_KEY: OWN }, "openai/gpt-6.1-sol"), { model: { provider: "openai", modelId: "gpt-6.1-sol" } }, "with OpenAI's key, OpenAI's model");
  assert.deepEqual(await adapters.codexModel({ ...ONLY, AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000" }, "openai/gpt-6.1-sol"), { model: { provider: "agent-model", modelId: "openai/gpt-6.1-sol" }, namedProvider: "openai" }, "through a gateway, the gateway's");
  // A model the definition names on OpenRouter (pi's name) goes there whatever key is beside it, and needs its key.
  assert.equal(adapters.claudeProvider({ ...ONLY, ANTHROPIC_API_KEY: OWN }, { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }).origin, "https://openrouter.ai/api");
  assert.throws(() => adapters.claudeProvider({ ANTHROPIC_API_KEY: OWN }, { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }), refused(/OPENROUTER_API_KEY/));
  // Another vendor's model through OpenRouter is not the harness's.
  assert.throws(() => adapters.claudeProvider(ONLY, { provider: "openrouter", modelId: "openai/gpt-6.1-sol" }), refused(/claude-agent runs Anthropic models/));
  assert.throws(() => adapters.codexProvider(ONLY, { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }), refused(/codex runs OpenAI models/));
  // No source at all: each names every key that would do.
  assert.throws(() => adapters.claudeProvider({}, anthropic), refused(/ANTHROPIC_API_KEY.*OPENROUTER_API_KEY/));
  assert.throws(() => adapters.codexProvider({}, openai), refused(/OPENAI_API_KEY.*OPENROUTER_API_KEY/));
});

test("or-4: claude-agent on OpenRouter alone: each request through its proxy to https://openrouter.ai/api/v1/messages, the key as a bearer token and no x-api-key, the model OpenRouter's slug", { timeout: 60_000 }, async (t) => {
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
  for (const request of seen) assert.deepEqual(request, { url: "https://openrouter.ai/api/v1/messages?beta=true", authorization: `Bearer ${KEY}`, apiKey: false, model: "anthropic/claude-sonnet-5.5" });
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
  const chosen = await adapters.codexModel(env, "openai/gpt-6.1-sol");
  assert.ok("model" in chosen, JSON.stringify(chosen));
  const adapter = await adapters.codexOf(env, { model: chosen.model, models: { getModel: () => undefined } }, load);
  const result = await runWorkflow(doc, {}, { runNode: createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] }) });
  assert.equal(result.status, "complete", JSON.stringify(result.error ?? null));
  assert.ok(seen.length >= 1, "a model request reached OpenRouter");
  for (const request of seen) assert.deepEqual(request, { url: "https://openrouter.ai/api/v1/responses", authorization: `Bearer ${KEY}`, model: "openai/gpt-6.1-sol" });
});

test("or-6: a server with only OPENROUTER_API_KEY runs claude-agent and codex, each with a default model on OpenRouter, and a definition naming Anthropic's or OpenAI's model saves with no warning", { timeout: 60_000 }, async (t) => {
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  // No request leaves the test: capabilities and saves check the harnesses, they never call a model.
  withEnv(t, { ...ONLY, AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }) }, SOURCES);
  const { api } = await serve(t, { faux: undefined });
  const harnesses = (await api("GET", "/capabilities")).body.harnesses;
  const row = (id) => harnesses.find((h) => h.id === id);
  assert.deepEqual(row("claude-agent"), { id: "claude-agent", available: true, steer: false, default_model: "openrouter/anthropic/claude-sonnet-5.5" });
  assert.deepEqual(row("codex"), { id: "codex", available: true, steer: false, default_model: "openrouter/openai/gpt-6.1-sol" });
  for (const [id, definition] of [
    ["claude", { harness: "claude-agent", model: "anthropic/claude-sonnet-5.5" }],
    ["claude-default", { harness: "claude-agent" }],
    ["coder", { harness: "codex", model: "openai/gpt-6.1-sol" }],
    ["coder-default", { harness: "codex" }],
  ]) {
    const saved = await api("POST", "/agents", agent(id, definition));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.warnings ?? [], [], `${id}: ${JSON.stringify(saved.body.warnings)}`);
  }
});
