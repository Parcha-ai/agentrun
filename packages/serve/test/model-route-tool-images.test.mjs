// A tool's result that holds an image (a browser's, a desktop's or a phone's screenshot) reaches the model on a translated
// route (runner/model-route.ts: a Messages request run on pi-ai's model of another provider), as it does on Anthropic's own:
// the tool_result's parts, in order, become pi-ai's toolResult content, text as text and each base64 image as an image, so
// pi-ai's request to the provider carries it. OpenRouter's chat completions take it as an attached image after the tool's
// message (a tool message there holds text alone); OpenAI's Responses take it in the call's output. A tool_result of text
// alone is sent as before. No network: the provider is a fetch that keeps what it was sent.
import assert from "node:assert/strict";
import { test } from "node:test";

const { routeOf } = await import("../dist/runner/model-route.js");

const KEY = `not-a-secret-${"route-key"}`;
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PNG}`;

/** A Messages request whose last turn answers a screenshot call with `content`. */
const answered = (content) => ({
  model: "route",
  max_tokens: 256,
  stream: true,
  messages: [
    { role: "user", content: "What does the page show?" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] },
  ],
});

/** The body pi-ai sent the provider for `request` on `model`'s route under `env`: the route's upstream keeps it and answers
 *  a refusal, so nothing goes on. Any other fetch in the meantime throws (no test reaches a real provider). */
async function sentFor(t, model, env, request) {
  const sent = [];
  const upstream = async (url, init = {}) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) });
    return new Response(JSON.stringify({ error: { message: "kept, not answered" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  // Restored in this call's own finally, never an after hook: a test that calls this twice gets the real fetch back.
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`a real fetch of ${String(url)}`); };
  try {
    const route = await routeOf(model, env, "default", undefined, upstream);
    assert.equal(typeof route.fetch, "function", `${model} answers through the route's translation`);
    const response = await route.fetch(`${route.provider.origin}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    await response.text();
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent.length, 1, `one request to the provider: ${JSON.stringify(sent.map((each) => each.url))}`);
  return sent[0].body;
}

const SHOT = [{ type: "text", text: "the page" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }];

test("OpenRouter: a tool's result with text and a PNG reaches the model with the image, after the tool's text", async (t) => {
  const body = await sentFor(t, "openrouter/openai/gpt-5", { OPENROUTER_API_KEY: KEY }, answered(SHOT));
  const at = body.messages.findIndex((message) => message.role === "tool");
  assert.ok(at >= 0, `the tool's message: ${JSON.stringify(body.messages)}`);
  assert.deepEqual([body.messages[at].tool_call_id, body.messages[at].content], ["toolu_1", "the page"], "the tool's text, as its message");
  const images = body.messages.slice(at + 1).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "image_url");
  assert.deepEqual(images.map((part) => part.image_url.url), [DATA_URL], `the screenshot, attached after the tool's message: ${JSON.stringify(body.messages.slice(at))}`);
});

test("OpenAI: a tool's result with text and a PNG reaches the model in the call's output, the image after the text", async (t) => {
  const body = await sentFor(t, "openai/gpt-6-sol", { OPENAI_API_KEY: KEY }, answered(SHOT));
  const output = body.input.find((item) => item.type === "function_call_output")?.output;
  assert.ok(Array.isArray(output), `the call's output holds parts: ${JSON.stringify(body.input)}`);
  assert.deepEqual(output.map((part) => part.type), ["input_text", "input_image"], JSON.stringify(output));
  assert.deepEqual([output[0].text, output[1].image_url], ["the page", DATA_URL]);
});

test("a tool's result of text alone is sent as before, on OpenRouter and on OpenAI", async (t) => {
  const routed = await sentFor(t, "openrouter/openai/gpt-5", { OPENROUTER_API_KEY: KEY }, answered([{ type: "text", text: "no image here" }]));
  const tool = routed.messages.find((message) => message.role === "tool");
  assert.equal(tool.content, "no image here");
  assert.equal(routed.messages.at(-1), tool, "nothing attached after it");
  const responses = await sentFor(t, "openai/gpt-6-sol", { OPENAI_API_KEY: KEY }, answered("no image here"));
  assert.equal(responses.input.find((item) => item.type === "function_call_output")?.output, "no image here", "a string result stays one text");
});
