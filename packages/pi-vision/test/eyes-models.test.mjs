// Eyes on pi's `Models`: one request a look through pi-ai's own catalog (here its faux provider), the parts in order
// after the line naming each fragment and the question last, always thinking on a model that reasons, the catalog's
// limits, an unknown price as null, a failed or cut request as an error, and the door found only where pi has it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { resolveLimits } from "@parcha/pi-vision";
import { modelsEyes, modelsOf } from "@parcha/pi-vision/durable";

const signal = () => new AbortController().signal;
const image = { type: "image", data: "AAAA", mimeType: "image/png", width: 2, height: 2, fragment: "scan.pdf#page=2" };
const usage = (total) => ({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });

function catalog(answer = () => "a cat") {
  const requests = [];
  const faux = fauxProvider({ models: [
    { id: "sees", input: ["text", "image"], reasoning: true, inputLimits: { images: { resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 3_000_000 } } } },
    { id: "plain", input: ["text", "image"], reasoning: false },
    { id: "blind", input: ["text"] },
  ] });
  faux.setResponses(Array.from({ length: 16 }, () => (context, options, state, model) => {
    requests.push({ model: model.id, content: context.messages.at(-1).content, reasoning: options?.reasoning });
    return fauxAssistantMessage([fauxText(answer())]);
  }));
  const models = createModels(); models.setProvider(faux.provider);
  return { models, requests };
}

test("a look is one request: the context, each part after the line naming its fragment, the question last; a look always thinks", async () => {
  const { models, requests } = catalog();
  const eyes = modelsEyes(models, { provider: "faux", modelId: "sees" }, { thinking: "off" });
  const answer = await eyes.see({ parts: [image, { type: "text", text: "page two's text", fragment: "scan.pdf#page=2" }], ask: "what animal?", context: "a form" }, signal());
  assert.deepEqual([answer.text, answer.model], ["a cat", "faux/sees"]);
  assert.deepEqual(Object.keys(answer.usage).sort(), ["cacheRead", "cacheWrite", "cost", "input", "output", "totalTokens"]);
  assert.deepEqual(requests, [{
    model: "sees", reasoning: "low",
    content: [
      { type: "text", text: "a form" }, { type: "text", text: "[scan.pdf#page=2]" }, { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "[scan.pdf#page=2]" }, { type: "text", text: "page two's text" }, { type: "text", text: "what animal?" },
    ],
  }]);
  await modelsEyes(models, { provider: "faux", modelId: "sees" }, { thinking: "high" }).see({ parts: [], ask: "q" }, signal());
  await modelsEyes(models, { provider: "faux", modelId: "sees" }).see({ parts: [], ask: "q" }, signal());
  await modelsEyes(models, { provider: "faux", modelId: "plain" }, { thinking: "high" }).see({ parts: [], ask: "q" }, signal());
  assert.deepEqual(requests.slice(1).map((r) => r.reasoning), ["high", "low", undefined], "a model that cannot reason is not asked to");
});

test("the eyes' limits are the catalog's, under the host's; what they accept is images, plus what the host says the route takes", () => {
  const { models } = catalog();
  const sees = models.getModel("faux", "sees");
  const eyes = modelsEyes(models, { provider: "faux", modelId: "sees" }, { limits: { requestBytes: 4_000_000 }, accepts: { video: true } });
  assert.deepEqual(eyes.limits, resolveLimits(sees, { requestBytes: 4_000_000 }));
  assert.equal(eyes.limits.image.maxWidth, 1568);
  assert.deepEqual(eyes.accepts, { image: true, video: true, pdf: false });
});

test("no eyes for a model the catalog lacks or one that takes no images", () => {
  const { models } = catalog();
  assert.equal(modelsEyes(models, { provider: "faux", modelId: "missing" }), undefined);
  assert.equal(modelsEyes(models, { provider: "other", modelId: "sees" }), undefined);
  assert.equal(modelsEyes(models, { provider: "faux", modelId: "blind" }), undefined);
});

test("the price is the request's when the catalog prices the model, and null when it does not", async () => {
  const door = (cost) => ({ getModel: (provider, id) => ({ id, input: ["image"], cost }), completeSimple: async () => ({ content: [{ type: "text", text: "ok" }], model: "m", usage: usage(0.0123), stopReason: "stop" }) });
  const priced = await modelsEyes(door({ input: 3, output: 15 }), { provider: "p", modelId: "m" }).see({ parts: [], ask: "q" }, signal());
  const unpriced = await modelsEyes(door({ input: 0, output: 0 }), { provider: "p", modelId: "m" }).see({ parts: [], ask: "q" }, signal());
  assert.deepEqual([priced.costUsd, unpriced.costUsd, unpriced.usage.cost.total], [0.0123, null, 0.0123]);
});

test("a failed request throws its first line; a request is cut at the timeout or by the caller", async (t) => {
  const answering = (message) => ({ getModel: (provider, id) => ({ id, input: ["image"] }), completeSimple: async () => ({ content: [], model: "m", usage: usage(0), ...message }) });
  await assert.rejects(modelsEyes(answering({ stopReason: "error", errorMessage: "upstream 503\nsecond line" }), { provider: "p", modelId: "m" }).see({ parts: [], ask: "q" }, signal()), (error) => /failed: upstream 503$/.test(error.message));
  const hanging = { getModel: (provider, id) => ({ id, input: ["image"] }), completeSimple: (model, context, options) => new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ content: [], model: "m", usage: usage(0), stopReason: "aborted", errorMessage: "cut" }))) };
  // AbortSignal.timeout's timer does not hold the process open; a real request's socket does, and this interval stands in.
  const open = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(open));
  const started = Date.now();
  await assert.rejects(modelsEyes(hanging, { provider: "p", modelId: "m" }, { timeoutMs: 200 }).see({ parts: [], ask: "q" }, signal()), /was cut/);
  assert.ok(Date.now() - started < 5_000);
  const caller = new AbortController();
  const pending = modelsEyes(hanging, { provider: "p", modelId: "m" }).see({ parts: [], ask: "q" }, caller.signal);
  caller.abort();
  await assert.rejects(pending, /was cut/);
});

test("the door is found only where pi hands it over", () => {
  const { models } = catalog();
  assert.equal(modelsOf({ models }), models);
  assert.deepEqual([modelsOf({}), modelsOf(null), modelsOf(undefined), modelsOf({ models: { getModel() {} } })], [undefined, undefined, undefined, undefined]);
});
