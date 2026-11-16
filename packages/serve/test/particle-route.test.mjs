// The direct Particle route through Pi's real Messages proxy and session provider. Every upstream is scripted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { routeOf } from "../dist/runner/model-route.js";
import { openTierProxies } from "../dist/runner/adapters/pi.js";
import { sessionProvider } from "../dist/port-models.js";

const KEY = `not-a-secret-${"particle"}`;
const USER = { role: "user", content: "Read the record and report its value.", timestamp: 1 };
const TOOL = { name: "read", description: "Read a record.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const chunk = (fields) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "particle-ai/particle-1", ...fields })}\n\n`;
const delta = (value, finish_reason = null) => chunk({ choices: [{ index: 0, delta: value, finish_reason }] });
const used = () => chunk({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 30 } } });
const toolReply = () => delta({ role: "assistant", reasoning_content: "I should inspect the record." })
  + chunk({ choices: [] }) // Particle's keep-alive chunk must not end the reply.
  + delta({ tool_calls: [{ index: 0, id: "call/one", type: "function", function: { name: "read", arguments: '{"id":' } }] })
  + delta({ tool_calls: [{ index: 0, function: { arguments: '"record-1"}' } }] })
  + delta({}, "tool_calls") + used() + "data: [DONE]\n\n";
const textReply = () => delta({ role: "assistant", content: "The value is 42." }) + delta({}, "stop") + used() + "data: [DONE]\n\n";

async function session(t, upstream) {
  const route = await routeOf("particle/particle-1", { PARTICLE_API_KEY: KEY }, "default", undefined, upstream);
  const booked = [];
  const hooks = { beforeRequest: async () => ({ turn: 1 }), afterRequest: async (usage, _ticket, ended) => void booked.push({ usage, ended }) };
  const tiers = await openTierProxies(new Map([["fast", route]]), hooks, undefined, ["read"]);
  t.after(() => tiers.close());
  const port = tiers.port("test", "fast");
  const models = createModels({});
  models.setProvider(sessionProvider(port.api, port, port.model, { provider: "test-session", keyName: "test-key", like: route.like, reasoning: false }));
  const model = models.getModel("test-session", port.model);
  return { route, model, booked, complete: (context, options) => models.completeSimple(model, context, options) };
}

function recorder(responses) {
  const sent = [];
  return {
    sent,
    fetch: async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init.headers), body: JSON.parse(init.body), signal: init.signal });
      return new Response(responses[Math.min(sent.length - 1, responses.length - 1)], { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  };
}

test("Particle's Pi route preserves native streamed tools, reasoning replay, cache affinity and usage through its proxy", async (t) => {
  const upstream = recorder([toolReply(), textReply()]);
  const at = await session(t, upstream.fetch);
  assert.equal(at.route.provider.api, "anthropic-messages", "Pi uses the existing translated route, never HTTP Responses upstream");
  assert.equal(at.model.contextWindow, 1_048_576);
  const first = await at.complete({ messages: [USER], tools: [TOOL] }, { reasoning: "max", sessionId: "conversation-one", maxTokens: 2048 });
  assert.equal(first.stopReason, "toolUse", first.errorMessage);
  assert.deepEqual(first.content.find((block) => block.type === "toolCall")?.arguments, { id: "record-1" });
  assert.equal(first.content.find((block) => block.type === "thinking")?.thinking, "I should inspect the record.");
  assert.deepEqual([first.usage.input, first.usage.cacheRead, first.usage.output, first.usage.reasoning, first.usage.totalTokens], [200, 800, 50, 30, 1050]);
  const call = first.content.find((block) => block.type === "toolCall");
  const second = await at.complete({ messages: [USER, first, { role: "toolResult", toolCallId: call.id, toolName: "read", content: [{ type: "text", text: "42" }], isError: false, timestamp: 2 }], tools: [TOOL] }, { reasoning: "low", sessionId: "conversation-one", maxTokens: 2048 });
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(second.content.find((block) => block.type === "text")?.text, "The value is 42.");
  assert.equal(upstream.sent.length, 2);
  for (const sent of upstream.sent) {
    assert.equal(sent.url, "https://api.particle.ai/v1/chat/completions");
    assert.equal(sent.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(sent.body.model, "particle-1");
    assert.equal(sent.body.tools[0].function.name, "read");
    assert.equal(sent.body.reasoning, undefined, "OpenRouter reasoning options are absent");
    assert.ok(sent.body.prompt_cache_key);
    assert.equal(sent.body.messages.some((message) => typeof message.content === "string" && message.content.includes("<tool_call>")), false);
  }
  assert.equal(upstream.sent[0].body.reasoning_effort, "max");
  assert.equal(upstream.sent[1].body.reasoning_effort, "low");
  assert.equal(upstream.sent[0].body.prompt_cache_key, upstream.sent[1].body.prompt_cache_key);
  const replay = upstream.sent[1].body.messages.find((message) => message.role === "assistant");
  assert.equal(replay.reasoning_content, "I should inspect the record.");
  assert.equal(replay.tool_calls[0].id, "call/one", "the original native call id is restored after the Messages hop");
  assert.equal(upstream.sent[1].body.messages.find((message) => message.role === "tool").tool_call_id, "call/one");
  await at.complete({ messages: [USER] }, { sessionId: "conversation-two", maxTokens: 2048 });
  assert.notEqual(upstream.sent[2].body.prompt_cache_key, upstream.sent[1].body.prompt_cache_key);
  assert.equal(upstream.sent[2].body.reasoning_effort, "none", "Pi's off request is explicit, not Particle's implicit high default");
  await at.complete({ messages: [USER] }, { sessionId: "conversation-one", cacheRetention: "none", maxTokens: 2048 });
  assert.equal(upstream.sent[3].body.prompt_cache_key, undefined, "cache opt-out crosses the proxy without an affinity hint");
  assert.ok(Math.abs(at.booked[0].usage.usd - 0.000124) < 1e-12, "cache tokens are not counted at full input price, and reasoning is not added to output again");
});

test("a direct Particle route uses a stable cache key for side calls without a session id", async () => {
  const upstream = recorder([textReply()]);
  const route = await routeOf("particle/particle-1", { PARTICLE_API_KEY: KEY }, "default", undefined, upstream.fetch);
  const request = { method: "POST", body: JSON.stringify({ model: "particle-1", max_tokens: 1000, messages: [{ role: "user", content: "Hello" }] }) };
  await (await route.fetch(`${route.provider.origin}/v1/messages`, request)).text();
  await (await route.fetch(`${route.provider.origin}/v1/messages`, request)).text();
  assert.ok(upstream.sent[0].body.prompt_cache_key);
  assert.equal(upstream.sent[0].body.prompt_cache_key, upstream.sent[1].body.prompt_cache_key);
});

test("a Particle stream error preserves terminal usage and is not retried by the translation", async () => {
  const upstream = recorder([delta({ role: "assistant", content: "Partial" }) + used() + chunk({ error: { type: "server_error", message: "worker failed" } }) + "data: [DONE]\n\n"]);
  const route = await routeOf("particle/particle-1", { PARTICLE_API_KEY: KEY }, "default", undefined, upstream.fetch);
  const result = await (await route.fetch(`${route.provider.origin}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "particle-1", max_tokens: 1000, messages: [{ role: "user", content: "Hello" }] }) })).text();
  assert.match(result, /worker failed/);
  assert.match(result, /"input_tokens":200/);
  assert.match(result, /"output_tokens":50/);
  assert.match(result, /"thinking_tokens":30/);
  assert.equal(upstream.sent.length, 1);
});

test("cancelling a Pi request aborts the direct Particle stream without resending", async (t) => {
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  let signal;
  let calls = 0;
  const at = await session(t, async (_url, init) => {
    calls++;
    signal = init.signal;
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(delta({ role: "assistant", content: "Started" })));
      init.signal.addEventListener("abort", () => controller.error(new DOMException("Cancelled", "AbortError")), { once: true });
      started();
    } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const cancel = new AbortController();
  const reply = at.complete({ messages: [USER] }, { signal: cancel.signal, sessionId: "cancelled-conversation", maxTokens: 2048 });
  await began;
  cancel.abort();
  assert.equal((await reply).stopReason, "aborted");
  for (let attempts = 0; !signal.aborted && attempts < 100; attempts++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(signal.aborted, true, "the abort reaches the provider request through the session proxy");
  assert.equal(calls, 1);
});

test("Particle's HTTP errors pass through Pi once, with credentials redacted", async (t) => {
  let calls = 0;
  const at = await session(t, async () => {
    calls++;
    return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: `Queue full for ${KEY}` } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
  });
  const reply = await at.complete({ messages: [USER] }, { maxTokens: 2048 });
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage, /Queue full/);
  assert.equal(reply.errorMessage.includes(KEY), false);
  assert.equal(calls, 1, "a retry is a caller decision, not an implicit paid resend");
});

test("a Particle reply cut after finish_reason but before usage is an error booked at unknown cost", async (t) => {
  const upstream = recorder([delta({ role: "assistant", content: "The answer reached the client." }) + delta({}, "stop") + "data: [DONE]\n\n"]);
  const at = await session(t, upstream.fetch);
  const reply = await at.complete({ messages: [USER] }, { maxTokens: 2048 });
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage, /usage/i);
  assert.equal(upstream.sent.length, 1);
  assert.equal(at.booked[0].usage.usd, null, "missing usage is unknown, never a successful free answer");
});
