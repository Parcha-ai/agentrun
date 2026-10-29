// unknownCost on its own, over a fake Models: a model serve has no price for answers at an unknown cost in every form an
// answer takes (each event's message, the final result pi's agent loop stores, and an answer that ends in an error),
// and a model it has a price for, a listed $0 among them, keeps its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unknownCost } from "../dist/cap.js";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const model = (id) => ({ id, name: id, api: "fake", provider: "fake", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_000, maxTokens: 1_000 });
const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

/** A Models whose every answer, priced $0 by its zero price, ends as `ending` ("stop" or "error"). Its stream is a plain
 *  async iterable whose result() is its own copy of the answer, as a provider's stream may give it, so nulling one of the
 *  two never reaches the other. */
function fakeModels(ending = "stop") {
  const send = () => {
    const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { ...zero } }, stopReason: ending, timestamp: 0, ...(ending === "error" ? { errorMessage: "the provider failed" } : {}) };
    const event = ending === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message };
    return { async *[Symbol.asyncIterator]() { yield event; }, result: async () => structuredClone(message) };
  };
  return { stream: send, streamSimple: send, complete: (...args) => send(...args).result(), completeSimple: (...args) => send(...args).result() };
}

/** What `models` gives for one request of `id`: each event's cost, and the final result's. */
async function answered(models, id) {
  const events = models.streamSimple(model(id), context);
  const seen = [];
  for await (const event of events) seen.push((event.message ?? event.error)?.usage?.cost?.total);
  return { events: seen, result: (await events.result()).usage.cost.total };
}

test("an unpriced model's answer is at unknown cost in its events AND in the final result (pi-ai's result() is the done or error event's message, so end()'s own value is never what is stored)", async () => {
  const models = await unknownCost(fakeModels(), new Set(["unlisted"]));
  assert.deepEqual(await answered(models, "unlisted"), { events: [null], result: null });
  assert.equal((await models.completeSimple(model("unlisted"), context)).usage.cost.total, null, "a complete call's answer too");
});

test("a model serve prices, a listed $0 among them, keeps its cost while other models are unpriced", async () => {
  const models = await unknownCost(fakeModels(), new Set(["unlisted"]));
  assert.deepEqual(await answered(models, "free"), { events: [0], result: 0 });
});

test("an unpriced model's answer that ends in an error is at unknown cost too", async () => {
  const models = await unknownCost(fakeModels("error"), new Set(["unlisted"]));
  assert.deepEqual(await answered(models, "unlisted"), { events: [null], result: null });
});
