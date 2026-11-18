import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogPrice, catalogPrices, providerModels, unpricedModels } from "../dist/model.js";

const env = { PARTICLE_API_KEY: "fake-test-key" };
const user = { role: "user", content: "Look up two files.", timestamp: 0 };
const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 60 } };
const chunk = (delta, finish_reason = null) => ({ id: "chat-test", object: "chat.completion.chunk", model: "particle-ai/particle-1", choices: [{ index: 0, delta, finish_reason }] });
const sse = (events) => new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const done = () => sse([chunk({ content: "Done." }), chunk({}, "stop"), { choices: [], usage }, "[DONE]"]);
async function setup() {
  const models = await providerModels(env);
  const model = models.getModel("particle", "particle-1");
  assert.ok(model, "direct Particle is registered independently of OpenRouter");
  return { models, model };
}

test("the direct catalog carries Particle's documented limits and price independently of the OpenRouter entry", async () => {
  const { models, model } = await setup();
  assert.deepEqual([model.api, model.baseUrl, model.contextWindow, model.maxTokens, model.input, model.reasoning], ["openai-completions", "https://api.particle.ai/v1", 1_048_576, 131_072, ["text", "image"], true]);
  assert.equal(model.toolsAs, undefined, "native tools are the default");
  assert.equal(models.getModel("openrouter", "particle-ai/particle-1").toolsAs, "text", "the measured OpenRouter workaround stays scoped to OpenRouter");
  assert.deepEqual(catalogPrice(await catalogPrices(), "particle/particle-1", "particle"), { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 });
  assert.deepEqual(await unpricedModels(env, "particle/particle-1"), []);
});

test("Particle streams native tool arguments and reasoning, then continues with the same call IDs and cache affinity", async () => {
  const { models, model } = await setup();
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    if (requests.length > 1) return done();
    return sse([
      chunk({ role: "assistant" }), chunk({}), // documented keep-alive
      chunk({ reasoning_content: "Check both files." }),
      chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":' } }, { index: 1, id: "call_b", type: "function", function: { name: "read_file", arguments: '{"path":"b' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '.txt"}' } }, { index: 0, function: { arguments: '"a.txt"}' } }] }),
      chunk({}, "tool_calls"), { choices: [], usage }, "[DONE]",
    ]);
  };
  const options = { fetch, reasoning: "high", sessionId: "conversation-one" };
  const events = [];
  const stream = models.streamSimple(model, { messages: [user], tools }, options);
  for await (const event of stream) events.push(event.type);
  const first = await stream.result();
  assert.equal(first.stopReason, "toolUse");
  assert.ok(events.includes("thinking_delta"));
  assert.ok(events.includes("toolcall_delta"));
  assert.deepEqual(first.content.filter((part) => part.type === "toolCall").map(({ id, name, arguments: args }) => ({ id, name, args })), [
    { id: "call_a", name: "read_file", args: { path: "a.txt" } },
    { id: "call_b", name: "read_file", args: { path: "b.txt" } },
  ]);
  const next = await models.completeSimple(model, { messages: [user, first, ...["a", "b"].map((id) => ({ role: "toolResult", toolCallId: `call_${id}`, toolName: "read_file", content: [{ type: "text", text: id }], isError: false, timestamp: 0 }))], tools }, options);
  assert.equal(next.stopReason, "stop");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "https://api.particle.ai/v1/chat/completions");
    assert.equal(request.headers.get("authorization"), `Bearer ${env.PARTICLE_API_KEY}`);
    assert.equal(request.body.model, "particle-1");
    assert.equal(request.body.reasoning_effort, "high");
    assert.equal(request.body.reasoning, undefined, "no OpenRouter reasoning object");
    assert.equal(request.body.tools[0].function.name, "read_file");
    assert.equal(request.body.tools[0].function.strict, undefined);
    assert.deepEqual(request.body.stream_options, { include_usage: true });
    assert.ok(request.body.prompt_cache_key);
  }
  assert.equal(requests[0].body.prompt_cache_key, requests[1].body.prompt_cache_key);
  const assistant = requests[1].body.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.reasoning_content, "Check both files.");
  assert.deepEqual(assistant.tool_calls.map((c) => c.id), ["call_a", "call_b"]);
  assert.deepEqual(requests[1].body.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ["call_a", "call_b"]);
  assert.deepEqual([first.usage.input, first.usage.cacheRead, first.usage.output, first.usage.reasoning, first.usage.totalTokens], [200, 800, 100, 60, 1100]);
  assert.ok(Math.abs(first.usage.cost.total - 0.000174) < 1e-12, "cache reads discounted, reasoning already included in output");
  assert.notEqual(first.usage.cost.totalFromProvider, true, "list-price estimate, not a provider bill");
});

test("Particle maps thinking levels explicitly and can turn thinking off", async () => {
  const { models, model } = await setup();
  for (const [reasoning, expected] of [[undefined, "none"], ["minimal", "low"], ["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "high"], ["max", "max"]]) {
    let body;
    const result = await models.completeSimple(model, { messages: [user] }, { reasoning, fetch: async (_url, init) => { body = JSON.parse(init.body); return done(); } });
    assert.equal(result.stopReason, "stop");
    assert.equal(body.reasoning_effort, expected);
    assert.equal(body.enable_thinking, undefined);
    assert.equal(body.thinking, undefined);
  }
});

test("Particle cache keys are bounded, stable, distinct, and omitted when affinity is disabled", async () => {
  const { models, model } = await setup();
  const keys = [];
  for (const opts of [{ sessionId: "🙂".repeat(300) }, { sessionId: "🙂".repeat(300) }, { sessionId: "other" }, { sessionId: "other", cacheRetention: "none" }, {}]) {
    await models.completeSimple(model, { messages: [user] }, { ...opts, fetch: async (_url, init) => { keys.push(JSON.parse(init.body).prompt_cache_key); return done(); } });
  }
  assert.ok(Buffer.byteLength(keys[0], "utf8") <= 256);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.deepEqual(keys.slice(3), [undefined, undefined]);
});

test("Particle HTTP failures surface without silently resending a paid request", async () => {
  const { models, model } = await setup();
  for (const status of [400, 401, 429, 503]) {
    let calls = 0;
    const result = await models.completeSimple(model, { messages: [user] }, { fetch: async () => { calls++; return new Response(JSON.stringify({ error: { message: `particle failure ${status}`, type: "api_error" } }), { status, headers: { "content-type": "application/json", "retry-after": "0" } }); } });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, new RegExp(String(status)));
    assert.equal(calls, 1);
  }
});

test("Particle cancellation aborts the pending HTTP request and makes no retry", async () => {
  const { models, model } = await setup();
  const controller = new AbortController();
  let calls = 0;
  let signal;
  const result = await models.completeSimple(model, { messages: [user] }, { signal: controller.signal, fetch: async (_url, init) => {
    calls++;
    signal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true });
      controller.abort();
    });
  } });
  assert.equal(result.stopReason, "aborted");
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test("Particle terminal stream errors preserve already-reported usage without retry", async () => {
  const { models, model } = await setup();
  let calls = 0;
  const result = await models.completeSimple(model, { messages: [user] }, { fetch: async () => { calls++; return sse([chunk({ content: "Partial" }), { choices: [], usage }, { error: { message: "upstream interrupted", type: "server_error" } }]); } });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /upstream interrupted/);
  assert.equal(result.usage.totalTokens, 1100);
  assert.equal(calls, 1);
});

test("Particle never reports a successful free completion when terminal usage is missing or malformed", async () => {
  const { models, model } = await setup();
  for (const terminal of [undefined, { prompt_tokens: 100 }, { prompt_tokens: 10, completion_tokens: -1 }]) {
    const result = await models.completeSimple(model, { messages: [user] }, { fetch: async () => sse([chunk({ content: "Finished" }), chunk({}, "stop"), ...(terminal ? [{ choices: [], usage: terminal }] : []), "[DONE]"]) });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /usage/i);
    assert.equal(result.usage.cost.total, undefined, "missing usage means unknown cost, never $0");
  }
});

test("Particle rejects malformed cache accounting, including a malformed final usage after an earlier valid report", async () => {
  const { models, model } = await setup();
  const badUsage = [
    { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cache_write_tokens: 100 } },
    { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: -5 },
    { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 101 },
  ];
  for (const invalid of badUsage) {
    for (const preceding of [[], [{ choices: [], usage }]]) {
      const result = await models.completeSimple(model, { messages: [user] }, { fetch: async () => sse([chunk({ content: "Finished" }), ...preceding, chunk({}, "stop"), { choices: [], usage: invalid }, "[DONE]"]) });
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage, /usage/);
      assert.equal(result.usage.cost.total, undefined, "malformed terminal accounting makes the cost unknown");
    }
  }
});

test("Particle validates the shared client's choice-level usage fallback after an earlier valid report", async () => {
  const { models, model } = await setup();
  const terminal = chunk({}, "stop");
  terminal.choices[0].usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cache_write_tokens: 100 } };
  const result = await models.completeSimple(model, { messages: [user] }, { fetch: async () => sse([chunk({ content: "Finished" }), { choices: [], usage }, terminal, "[DONE]"]) });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /usage/);
  assert.equal(result.usage.cost.total, undefined, "malformed choice-level usage cannot overwrite the validated accounting");
});

test("Particle requires the terminal DONE frame even after finish_reason and usage", async () => {
  const { models, model } = await setup();
  const result = await models.completeSimple(model, { messages: [user] }, { fetch: async () => sse([chunk({ content: "Partial" }), chunk({}, "stop"), { choices: [], usage }]) });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /DONE/);
});

test("Particle accepts the terminal marker across byte chunks and SSE line endings", async () => {
  const { models, model } = await setup();
  for (const newline of ["\n", "\r\n", "\r"]) {
    const wire = [chunk({ content: "Done" }), chunk({}, "stop"), { choices: [], usage }, "[DONE]"].map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}${newline}${newline}`).join("");
    const bytes = new TextEncoder().encode(wire);
    const result = await models.completeSimple(model, { messages: [user] }, { fetch: async () => new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } }) });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.usage.totalTokens, 1100);
  }
});
