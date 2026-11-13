// The strings the runner keys on in pi's own records (runner/pi-stop.ts PI_STOP), each read from pi itself, from where
// the runner reads it:
// - `length`: pi-ai's stop reason for an answer its provider cut at the output limit (runner/loop.ts cutLast), from a real
//   request through pi-ai's Anthropic Messages client to a scripted provider;
// - `aborted`: pi-durable's diagnostic code on the result of a tool call that was aborted (live/translate.ts shownResult),
//   from a real Harness whose conversation is aborted while its tool runs.
// A pi rename of either fails here, by name, rather than in a run that silently stops reading a cut answer as cut, or a
// stopped call as stopped. Local only: no network, no key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const { PI_STOP } = await import("../dist/runner/pi-stop.js");

const MODEL = "claude-sonnet-4-5";
const PROVIDER = "pi-stop-check";

/** pi's models over a provider whose every request `fetch` answers. */
function modelsOn() {
  const models = createModels();
  models.setProvider(createProvider({
    id: PROVIDER,
    baseUrl: "https://pi-stop.invalid",
    auth: { apiKey: { name: "PI_STOP_KEY", resolve: async () => ({ auth: { apiKey: `not-a-secret-${"stop"}` }, source: "test" }) } },
    models: [{ id: MODEL, name: MODEL, api: "anthropic-messages", provider: PROVIDER, baseUrl: "https://pi-stop.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64 }],
    api: anthropicMessagesApi(),
  }));
  return { models, model: models.getModel(PROVIDER, MODEL) };
}

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const start = { type: "message_start", message: { id: "msg_stop", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } };

test("pi-ai names an answer its provider cut at the output limit as PI_STOP.length", async () => {
  const { models, model } = modelsOn();
  const fetch = async () => new Response([
    frame(start),
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "and then" } }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 64 } }),
    frame({ type: "message_stop" }),
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  const message = await models.completeSimple(model, { messages: [{ role: "user", content: "Say a lot.", timestamp: 0 }] }, { maxTokens: 64, fetch });
  assert.equal(message.stopReason, PI_STOP.length, `pi-ai's stop reason for a cut answer: ${message.stopReason}`);
});

test("pi-durable codes the result of a tool call aborted while it ran as PI_STOP.aborted", async () => {
  // The model calls `wait` once; the tool runs until its call is aborted, and says when it started.
  const faux = fauxProvider();
  faux.setResponses([() => fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }), () => fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
  const models = createModels();
  models.setProvider(faux.provider);
  const fauxModel = faux.getModel();
  let started = () => {};
  const running = new Promise((resolve) => (started = resolve));
  const wait = defineTool({
    name: "wait", description: "Runs until it is aborted.", parameters: { type: "object", properties: {} },
    execute: (_args, _api, context) => new Promise((_resolve, reject) => {
      started();
      context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal.reason ?? new Error("aborted")), { once: true });
    }),
  });
  const kernel = defineExtension({ name: "pi-stop-check", tools: [wait] });
  const registry = createRegistry();
  registry.install(kernel);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: fauxModel.provider, modelId: fauxModel.id }, extensions: [kernel] } });
    await root.submit({ type: "input", content: "Wait.", requestId: "pi-stop:input" }, ctx);
    await running;
    await root.abort(ctx);
    await harness.waitForIdle(ctx);
    const entries = [];
    for (let cursor; ; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, ctx);
      entries.push(...page.items);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    const results = entries.filter((entry) => entry.model?.[0]?.role === "toolResult");
    assert.equal(results.length, 1, `one result, the aborted call's: ${JSON.stringify(entries.map((entry) => entry.kind))}`);
    const codes = (results[0].data?.diagnostics ?? []).map((diagnostic) => diagnostic.code);
    assert.ok(codes.includes(PI_STOP.aborted), `pi-durable's diagnostic codes on an aborted call's result: ${JSON.stringify(results[0].data?.diagnostics)}`);
  } finally {
    await harness.close(ctx);
  }
});
