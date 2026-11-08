// The kernel's rule before a side effect holds for a pi run's model requests as for its tool calls (the storeIntentFlush
// barrier: "a tool call, a model request"): every paid request leaves only after a flush made the records before it
// durable (pi committed them, at synchronous=NORMAL not yet on disk), so a machine lost after the send never loses the
// record that the request was asked and sends it again. Read from the order the loop's flush and the model's requests
// happen in, on a real store and runner, for a run that only talks (no tool call flushes for it): on pi-ai's faux
// provider, and on a stub provider that builds a real Anthropic Messages body (pi-ai's own implementation, its fetch a
// script: no network), where a request is one flush, after the attempt's request checkpoint was stored.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createPiLoop } = await import("../dist/runner/loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const STUB_MODEL = "claude-sonnet-4-5";

/** The answer of a step: the model's words, or a call. */
const stepOf = (steps, answers) => steps[answers] ?? { say: "" };

/** pi-ai's faux provider playing `steps`; `failFirst`: the first request answers a retryable provider error (429). */
function fauxModels(steps, seen, failFirst) {
  const faux = fauxProvider();
  let failed = !failFirst;
  faux.setResponses(Array.from({ length: 16 }, () => (context) => {
    seen.push("request");
    if (!failed) {
      failed = true;
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Too Many Requests: rate limited" });
    }
    const step = stepOf(steps, context.messages.filter((message) => message.role === "assistant").length);
    return "call" in step ? fauxAssistantMessage([fauxToolCall(step.call, {})], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText(step.say)], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { models, model: { provider: model.provider, modelId: model.id } };
}

/** A provider that builds a real Anthropic Messages body and sends it to a scripted fetch: the SSE answer of `steps`. */
function stubModels(steps, seen) {
  const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  const fetch = async (_url, init = {}) => {
    seen.push("request");
    const body = JSON.parse(String(init.body ?? "{}"));
    const step = stepOf(steps, (body.messages ?? []).filter((message) => message.role === "assistant").length);
    const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } };
    const block = "call" in step ? { type: "tool_use", id: "toolu_1", name: step.call, input: {} } : { type: "text", text: "" };
    const delta = "call" in step ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: step.say };
    return sse([
      start,
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "call" in step ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
  };
  const api = anthropicMessagesApi();
  const models = createModels();
  models.setProvider(createProvider({
    id: "stub",
    baseUrl: "https://stub.invalid",
    auth: { apiKey: { name: "STUB_KEY", resolve: async () => ({ auth: { apiKey: `not-a-secret-${"x"}` }, source: "test" }) } },
    models: [{ id: STUB_MODEL, name: STUB_MODEL, api: "anthropic-messages", provider: "stub", baseUrl: "https://stub.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }],
    api: { stream: (model, context, options) => api.stream(model, context, { ...options, fetch }), streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options, fetch }) },
  }));
  return { models, model: { provider: "stub", modelId: STUB_MODEL } };
}

/** The order of flushes and model requests in one run whose model answers `steps` in turn. At each flush, whether the
 *  run's latest generation had its request checkpoint stored ("flush:request"), or not ("flush"). */
async function order(t, steps, { failFirst = false, provider = "faux" } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-model-flush-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flush" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const seen = [];
  const { models, model } = provider === "stub" ? stubModels(steps, seen) : fauxModels(steps, seen, failFirst);
  const requestStored = async () => {
    const row = await server.runs.get("run-1");
    const { tasks } = await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
    const generations = tasks.filter((task) => task.kind === "pi.generation");
    return generations.at(-1)?.state?.checkpoint?.phase === "request";
  };
  const read = { name: "read", description: "A read.", parameters: { type: "object", properties: {} }, replaySafe: true, run: async () => (seen.push("read"), "read") };
  const inner = createPiLoop(() => ({ models, model, input: "Talk.", tools: [read], hooks: quiet }));
  const createLoop = (deps) => inner({ ...deps, flush: async () => (seen.push((await requestStored()) ? "flush:request" : "flush"), deps.flush()) });
  runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}: ${JSON.stringify(seen)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return seen;
}

const isFlush = (what) => what === "flush" || what === "flush:request";
/** Whether every request has a flush after the one before it (or after the run's start). */
const flushedBeforeEach = (seen) => seen.every((what, index) => what !== "request" || seen.slice(seen.lastIndexOf("request", index - 1) + 1, index).some(isFlush));

test("a pi run's model request leaves only after a flush: one that only answers", async (t) => {
  const seen = await order(t, [{ say: "done" }]);
  assert.ok(seen.includes("request"), `the model was asked: ${JSON.stringify(seen)}`);
  assert.ok(flushedBeforeEach(seen), `a flush before each request: ${JSON.stringify(seen)}`);
});

test("a pi run's retried model request leaves after a flush of its own: a retry never skips it", async (t) => {
  const seen = await order(t, [{ say: "done" }], { failFirst: true });
  assert.equal(seen.filter((what) => what === "request").length, 2, `the request and its retry: ${JSON.stringify(seen)}`);
  assert.ok(flushedBeforeEach(seen), `a flush before the request and before its retry: ${JSON.stringify(seen)}`);
});

test("a pi run's model requests each leave after a flush: a replay-safe call between them flushes nothing for them", async (t) => {
  const seen = await order(t, [{ call: "read" }, { say: "done" }]);
  assert.equal(seen.filter((what) => what === "request").length, 2, `two requests: ${JSON.stringify(seen)}`);
  assert.ok(flushedBeforeEach(seen), `a flush before each request: ${JSON.stringify(seen)}`);
});

test("on a provider that builds a body, a request is one flush, after the attempt's request checkpoint was stored", async (t) => {
  const seen = await order(t, [{ say: "done" }], { provider: "stub" });
  assert.deepEqual(seen, ["flush:request", "request"], "one flush, its request checkpoint durable by it, then the request");
});
