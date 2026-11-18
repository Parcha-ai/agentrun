// A learned workflow reaches Pi's model through a side port, with no catalog argument to portModels. The port carries
// the model metadata from the actual route; no additional provider connection or billing path is created.
import assert from "node:assert/strict";
import { test } from "node:test";
import { routeOf } from "../dist/runner/model-route.js";
import { openTierProxies } from "../dist/runner/adapters/pi.js";
import { portModels } from "../dist/port-models.js";

const KEY = `not-a-secret-${"particle-side"}`;
const CONTEXT = { messages: [{ role: "user", content: "Summarize the record.", timestamp: 1 }] };
const chunk = (fields) => `data: ${JSON.stringify({ id: "completion-1", object: "chat.completion.chunk", created: 1, model: "particle-ai/particle-1", ...fields })}\n\n`;
const ANSWER = chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Check the facts.", content: "Summary." }, finish_reason: "stop" }] })
  + chunk({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 30 } } }) + "data: [DONE]\n\n";

async function open(t) {
  const sent = [];
  const route = await routeOf("particle/particle-1", { PARTICLE_API_KEY: KEY }, "default", undefined, async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(ANSWER, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const booked = [];
  const tiers = await openTierProxies(new Map([["strong", route]]), {
    beforeRequest: async () => ({ turn: 1 }), afterRequest: async (usage) => void booked.push(usage),
  });
  t.after(() => tiers.close());
  return { tiers, sent, booked, port: tiers.port("learned_workflow", "strong") };
}

test("Particle side models inherit the Pi port's model metadata and preserve reasoning through the booked route", async (t) => {
  const at = await open(t);
  const models = await portModels(() => at.port);
  const model = models.getModel("ignored", "session");
  assert.equal(model.contextWindow, 1_048_576, "the real context window, not the generic port fallback");
  assert.equal(model.maxTokens, 131_072);
  const reply = await models.completeSimple(model, CONTEXT, { reasoning: "max", sessionId: "learned-node-one", maxTokens: 2048 });
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.equal(at.sent[0].reasoning_effort, "max", "the side call's requested effort survives both protocol hops");
  assert.deepEqual([reply.usage.input, reply.usage.cacheRead, reply.usage.output, reply.usage.reasoning], [200, 800, 50, 30]);
  assert.ok(Math.abs(at.booked[0].usd - 0.000124) < 1e-12);
  await models.completeSimple(model, CONTEXT, { reasoning: "low", sessionId: "learned-node-one", maxTokens: 2048 });
  assert.equal(at.sent[1].reasoning_effort, "low");
  assert.equal(at.sent[1].prompt_cache_key, at.sent[0].prompt_cache_key);
  await models.completeSimple(model, CONTEXT, { reasoning: "high", sessionId: "learned-node-one", cacheRetention: "none", maxTokens: 2048 });
  assert.equal(at.sent[2].prompt_cache_key, undefined);
  // llm's one-shot completer has no conversation id: it retains the translation's route-local fallback.
  await models.completeSimple(model, CONTEXT, { reasoning: "high", maxTokens: 2048 });
  await models.completeSimple(model, CONTEXT, { reasoning: "high", maxTokens: 2048 });
  assert.ok(at.sent[3].prompt_cache_key);
  assert.equal(at.sent[4].prompt_cache_key, at.sent[3].prompt_cache_key);
});

test("a Particle side registry follows live ports across drives and refuses stale model objects", async (t) => {
  let current;
  const models = await portModels(() => current);
  assert.equal(models.getModel("ignored", "session"), undefined);
  const first = await open(t);
  current = first.port;
  const previous = models.getModel("ignored", "session");
  assert.equal((await models.completeSimple(previous, CONTEXT, { reasoning: "max", maxTokens: 2048 })).stopReason, "stop");
  const next = await open(t);
  current = next.port;
  const model = models.getModel("ignored", "session");
  assert.notEqual(model, previous);
  assert.equal(model.contextWindow, 1_048_576);
  assert.throws(() => models.completeSimple(previous, CONTEXT), /no turn holds its proxy/);
  assert.equal((await models.completeSimple(model, CONTEXT, { reasoning: "low", maxTokens: 2048 })).stopReason, "stop");
  assert.equal(first.sent.length, 1);
  assert.equal(next.sent.length, 1);
  assert.equal(next.sent[0].reasoning_effort, "low");
  current = undefined;
  assert.equal(models.getModel("ignored", "session"), undefined);
  assert.throws(() => models.completeSimple(model, CONTEXT), /no turn holds its proxy/);
});
