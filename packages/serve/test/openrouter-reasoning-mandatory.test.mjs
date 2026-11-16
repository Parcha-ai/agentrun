// A model OpenRouter says must reason (its GET /api/v1/models entry's `reasoning.mandatory: true`) is never sent reasoning
// "none". On the runner's route (model-route.ts routeOf, the translation pi's session reaches an OpenRouter model through),
// pi-ai's Chat Completions client turns reasoning off with `reasoning: {effort: "none"}` unless the model's thinkingLevelMap
// maps off to null, and OpenRouter answers that with a 400, "Reasoning is mandatory for this endpoint and cannot be
// disabled.", on every request. ERNIE 5.5 Flash Preview (free) is one serve adds to pi-ai's catalog (local-models.ts
// ADDED_MODELS), a copy of Ling 3.1 Flash, whose map is null. Ling 3.2 Flash (free), which lists `reasoning` among its
// supported parameters too but whose reasoning is not mandatory, keeps off. The mirror of #2918 (Sonnet 5.5 on a gateway).
// The upstream here is a stand-in for OpenRouter's Chat Completions endpoint that refuses as OpenRouter does: nothing
// leaves loopback.
import assert from "node:assert/strict";
import { test } from "node:test";

const { routeOf } = await import("../dist/runner/model-route.js");

/** OpenRouter's key, plainly a test value. */
const KEY = `not-a-secret-${"openrouter"}`;
const OR_ALONE = { OPENROUTER_API_KEY: KEY };
const ERNIE = "baidu/ernie-5.5-flash-preview:free";
const LING = "inclusionai/ling-3.2-flash:free";
/** OpenRouter's `reasoning.mandatory`, as GET https://openrouter.ai/api/v1/models answered on 2026-11-16. */
const MANDATORY_HERE = new Set([ERNIE]);
const MANDATORY = "Reasoning is mandatory for this endpoint and cannot be disabled.";

const chunk = (model, fields) => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model, ...fields })}\n\n`;
const answer = (model) => chunk(model, { choices: [{ index: 0, delta: { role: "assistant", content: "Hello." }, finish_reason: null }] })
  + chunk(model, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  + chunk(model, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0 } })
  + "data: [DONE]\n\n";

/** OpenRouter's stand-in: a request that turns reasoning off on a model that must reason is refused 400 in OpenRouter's
 *  words; any other is answered. Every request body is kept. */
function openRouter() {
  const bodies = [];
  const fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://openrouter.ai/api/v1/chat/completions") return new Response("not here", { status: 404 });
    const body = JSON.parse(String(input instanceof Request ? await input.text() : init?.body ?? "{}"));
    bodies.push(body);
    if (MANDATORY_HERE.has(body.model) && body.reasoning?.effort === "none") {
      return new Response(JSON.stringify({ error: { code: 400, message: MANDATORY } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(answer(body.model), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, bodies };
}

/** One Messages request through the route of OpenRouter's `model`, as pi's session sends one with thinking off (no
 *  thinking block): the bodies OpenRouter took and the stream the route answered. */
async function askOn(model) {
  const upstream = openRouter();
  const route = await routeOf(`openrouter/${model}`, OR_ALONE, "default", undefined, upstream.fetch);
  assert.ok(route.fetch, "the route translates Messages to OpenRouter's Chat Completions");
  const response = await route.fetch("http://model-route.invalid/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: route.model, max_tokens: 1_000, stream: true, messages: [{ role: "user", content: "Say hello." }] }),
  });
  return { bodies: upstream.bodies, text: await response.text() };
}

test("ERNIE 5.5 Flash Preview (free), which OpenRouter says must reason: its request never turns reasoning off, so OpenRouter answers it", async () => {
  const { bodies, text } = await askOn(ERNIE);
  assert.equal(bodies.length, 1, "one request reached OpenRouter");
  assert.notEqual(bodies[0].reasoning?.effort, "none", `reasoning sent: ${JSON.stringify(bodies[0].reasoning)}`);
  assert.ok(!text.includes(MANDATORY), `the answer: ${text.slice(0, 400)}`);
  assert.match(text, /Hello\./);
});

test("Ling 3.2 Flash (free), which takes reasoning but need not: thinking off still sends effort none", async () => {
  const { bodies, text } = await askOn(LING);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].reasoning, { effort: "none" });
  assert.match(text, /Hello\./);
});
