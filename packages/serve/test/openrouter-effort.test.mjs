// The run's thinking level (low, medium, high) reaches the model's request on every harness on OpenRouter's key alone,
// as each harness's route sends it to OpenRouter. Each request is sent to https://openrouter.ai as serve builds the
// route, through a fetch that records it and hands it to a loopback gateway (fixtures/faux-gateway.mjs) to answer: no
// real key, no network.
//   - pi, on pi-ai's openrouter provider for its default (openrouter/openai/gpt-6-sol): POST /api/v1/chat/completions
//     with OpenRouter's `reasoning: { effort }`;
//   - claude-agent, on the pinned Agent SDK and CLI: POST /api/v1/messages with adaptive thinking and
//     `output_config.effort`;
//   - codex, on the pinned Codex binary: POST /api/v1/responses with `reasoning.effort`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { findCodex } from "../../run-adapters-codex/dist/binary.js";
import { verifyCodexBinary } from "../../run-adapters-codex/dist/verify.js";
import * as adapters from "../dist/adapters.js";
import { runModels } from "../dist/model.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { claudeData, scratch } from "./support.mjs";

const KEY = `not-a-secret-${"openrouter"}`;
const ONLY = { OPENROUTER_API_KEY: KEY };
const LEVELS = ["low", "medium", "high"];
const noSetpriv = !existsSync("/usr/bin/setpriv") && "no setpriv here";
const codexBinary = verifyCodexBinary(findCodex());
const noCodex = codexBinary instanceof Error && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== "1" ? codexBinary.message : false;

/** A loopback gateway, and a fetch that records each request's URL and authorization and sends it there. */
async function openrouter(t, answer) {
  const gw = await startFauxGateway();
  t.after(() => gw.close());
  const sent = [];
  const fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(url), authorization: headers.get("authorization"), apiKey: headers.has("x-api-key"), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (answer) return answer(sent.at(-1));
    const { pathname, search } = new URL(url);
    return globalThis.fetch(`${gw.url}${pathname}${search}`, init);
  };
  return { gw, sent, fetch };
}

/** One turn of `adapter` at `level`: its end. */
async function turn(t, adapter, level) {
  const store = memorySessionStore();
  const spec = { key: `effort:${level}`, label: `effort-${level}`, system: ["Answer."], tools: [], context: "fresh", thinking: level };
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const session = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, dir: await scratch(t), onEvent: () => {} });
  try {
    await session.send("Say hi.");
    return await session.turnEnd();
  } finally {
    await session.close();
  }
}

test("pi on OpenRouter alone: its default's request carries OpenRouter's reasoning effort at each level, to /api/v1/chat/completions with the key as a bearer token", { timeout: 60_000 }, async (t) => {
  const { models, model } = await runModels(ONLY, undefined);
  assert.equal(`${model.provider}/${model.modelId}`, "openrouter/openai/gpt-6-sol");
  const full = models.getModel(model.provider, model.modelId);
  const provider = models.getProvider(model.provider);
  for (const level of LEVELS) {
    const { sent, fetch } = await openrouter(t);
    const stream = provider.streamSimple(full, { messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }] }, { reasoning: level, apiKey: KEY, fetch });
    await stream.result();
    assert.ok(sent.length >= 1, `${level}: a request`);
    for (const request of sent) {
      assert.deepEqual([request.url, request.authorization, request.apiKey], ["https://openrouter.ai/api/v1/chat/completions", `Bearer ${KEY}`, false], level);
      assert.deepEqual(request.body.reasoning, { effort: level }, level);
    }
  }
});

test("claude-agent on OpenRouter alone: each level reaches /api/v1/messages as adaptive thinking at that effort, with Anthropic's own id and the key as a bearer token", { timeout: 300_000, skip: noSetpriv }, async (t) => {
  const real = await import("@parcha/agentrun-harness-claude");
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const chosen = adapters.claudeModel(ONLY, undefined);
  const data = await claudeData(t);
  for (const level of LEVELS) {
    const { sent, fetch } = await openrouter(t);
    const load = async () => ({ ...real, claudeAgentAdapter: (options) => real.claudeAgentAdapter({ ...options, fetch }) });
    const adapter = await adapters.claudeOf({ ...ONLY, AGENTRUN_SERVE_DATA: data }, { model: chosen.model, models: builtinModels() }, load);
    const end = await turn(t, adapter, level);
    assert.equal(end.status, "completed", `${level}: ${JSON.stringify(end)}`);
    const thinking = sent.filter((r) => r.body?.thinking !== undefined);
    assert.ok(thinking.length >= 1, `${level}: a request that thinks, of ${sent.length}`);
    for (const request of sent) assert.deepEqual([request.url, request.authorization, request.apiKey, request.body.model], ["https://openrouter.ai/api/v1/messages?beta=true", `Bearer ${KEY}`, false, "claude-sonnet-5-5"], level);
    for (const request of thinking) assert.deepEqual([request.body.thinking.type, request.body.output_config?.effort], ["adaptive", level], level);
  }
});

/** A Responses stream the pinned Codex reads to its end: one message, then the completed response with its usage. */
const SAY = { type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] };
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 110 };
const said = (n) => [
  { type: "response.created", response: { id: `resp_${n}`, object: "response", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { ...SAY, status: "in_progress" } },
  { type: "response.output_item.done", output_index: 0, item: SAY },
  { type: "response.completed", response: { id: `resp_${n}`, object: "response", status: "completed", output: [SAY], usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("codex on OpenRouter alone: each level reaches /api/v1/responses as reasoning.effort, with the model's whole id and the key as a bearer token", { timeout: 300_000, skip: noCodex || noSetpriv }, async (t) => {
  const real = await import("@parcha/agentrun-harness-codex");
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const chosen = await adapters.codexModel(ONLY, undefined);
  assert.deepEqual(chosen, { model: { provider: "openai", modelId: "gpt-6-sol" } });
  for (const level of LEVELS) {
    const { sent, fetch } = await openrouter(t, () => new Response(said(sent.length), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const dir = await scratch(t);
    const load = async () => ({ ...real, codexAdapter: (options) => real.codexAdapter({ ...options, sessionsDir: dir, fetch }) });
    const adapter = await adapters.codexOf(ONLY, { model: chosen.model, models: builtinModels() }, load);
    const end = await turn(t, adapter, level);
    assert.equal(end.status, "completed", `${level}: ${JSON.stringify(end)}`);
    assert.ok(sent.length >= 1, `${level}: a request`);
    for (const request of sent) {
      assert.deepEqual([request.url, request.authorization, request.body.model], ["https://openrouter.ai/api/v1/responses", `Bearer ${KEY}`, "openai/gpt-6-sol"], level);
      assert.equal(request.body.reasoning?.effort, level, `${level}: ${JSON.stringify(request.body.reasoning)}`);
    }
  }
});
