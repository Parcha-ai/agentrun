// The loopback model gateway the gateway contract tests share (fixtures/faux-gateway.mjs): it answers each of its three
// APIs, streamed and whole, with the usage it was given, under a base with a path too, records every request (method,
// path, query, key headers, body), and answers anything else 404 while still recording it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

/** The JSON events of an SSE body, and whether it ended `data: [DONE]`. */
function events(text) {
  const data = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice("data: ".length));
  return { events: data.filter((d) => d !== "[DONE]").map((d) => JSON.parse(d)), done: data.at(-1) === "[DONE]" };
}

test("the gateway answers Responses, Messages and Chat Completions with their usage, streamed and whole, under a base path too, and records each request", async (t) => {
  const gw = await startFauxGateway({ text: "hello", usage: { input: 1000, output: 100 } });
  t.after(() => gw.close());
  assert.match(gw.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const post = (path, headers, body) => fetch(`${gw.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  // Responses, streamed: text, then response.completed with the usage, then [DONE].
  const responses = await post("/v1/responses", { authorization: "Bearer k1" }, { model: "openai/gpt-x", stream: true, input: [] });
  assert.equal(responses.status, 200);
  assert.match(responses.headers.get("content-type"), /text\/event-stream/);
  const r = events(await responses.text());
  assert.equal(r.events.find((e) => e.type === "response.output_text.delta")?.delta, "hello");
  assert.equal(r.events.at(-1).type, "response.completed");
  assert.deepEqual([r.events.at(-1).response.usage.input_tokens, r.events.at(-1).response.usage.output_tokens], [1000, 100]);
  assert.ok(r.done, "a Responses stream ends [DONE]");

  // Messages, streamed under OpenRouter's /api base, with a query: named events, the usage on message_delta.
  const messages = await post("/api/v1/messages?beta=true", { "x-api-key": "k2", "anthropic-version": "2023-06-01" }, { model: "claude-x", stream: true, messages: [] });
  assert.equal(messages.status, 200);
  const text = await messages.text();
  assert.match(text, /^event: message_start\n/m);
  const m = events(text);
  assert.equal(m.events.find((e) => e.type === "content_block_delta")?.delta.text, "hello");
  assert.deepEqual(m.events.find((e) => e.type === "message_delta")?.usage, { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 });
  assert.equal(m.events.at(-1).type, "message_stop");

  // Chat Completions, whole: one JSON answer with its usage.
  const chat = await post("/v1/chat/completions", { authorization: "Bearer k3" }, { model: "openai/gpt-y", messages: [] });
  assert.equal(chat.status, 200);
  const c = await chat.json();
  assert.equal(c.choices[0].message.content, "hello");
  assert.deepEqual([c.usage.prompt_tokens, c.usage.completion_tokens], [1000, 100]);

  // Anything else: 404, still recorded.
  assert.equal((await post("/responses", { authorization: "Bearer k4" }, { model: "m" })).status, 404, "a path that does not end in a route is not answered");
  assert.equal((await fetch(`${gw.url}/v1/models`)).status, 404, "nor a GET");

  assert.deepEqual(gw.requests.map((q) => [q.method, q.path, q.query, q.headers.authorization, q.headers["x-api-key"], q.headers["anthropic-version"], q.body?.model ?? null]), [
    ["POST", "/v1/responses", "", "Bearer k1", undefined, undefined, "openai/gpt-x"],
    ["POST", "/api/v1/messages", "beta=true", undefined, "k2", "2023-06-01", "claude-x"],
    ["POST", "/v1/chat/completions", "", "Bearer k3", undefined, undefined, "openai/gpt-y"],
    ["POST", "/responses", "", "Bearer k4", undefined, undefined, "m"],
    ["GET", "/v1/models", "", undefined, undefined, undefined, null],
  ]);
});
