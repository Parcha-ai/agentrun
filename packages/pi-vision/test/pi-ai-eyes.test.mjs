// Eyes on a pi-ai model, through pi-ai's own request path (`completeSimple`) on its faux provider, so no request leaves
// the process: one request a look with the question first and the parts after it, the host's thinking level and never
// off, the key read at the request and never in the answer, usage and a price from the model's own rates (null when
// it has none), and a request cut at its timeout with a cause the model can read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { SEE_TIMEOUT_MS } from "@parcha/pi-vision";
import { piAiEyes } from "@parcha/pi-vision/eyes/pi-ai";
import { SENTINEL_EYES_KEY } from "@parcha/pi-vision/testing";

const PRICE = { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 };
const faux = (definition = {}) => registerFauxProvider({ models: [{ id: "faux-eyes", reasoning: true, input: ["text", "image"], cost: PRICE, ...definition }] });
const signal = () => new AbortController().signal;
const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", width: 1, height: 1, fragment: "a.png" };

test("one request: the question first, then the parts in order; the host's level, the key read at the request; usage and price on the answer", async (t) => {
  const provider = faux();
  t.after(() => provider.unregister());
  const seen = [];
  provider.setResponses([(context, options) => { seen.push({ context, options }); return fauxAssistantMessage("A form with two fields."); }]);
  let reads = 0;
  const eyes = piAiEyes(provider.getModel(), { apiKey: () => { reads += 1; return SENTINEL_EYES_KEY; }, reasoning: "low" });
  assert.equal(reads, 0, "the key is read at a request, not when the eyes are built");
  assert.deepEqual(eyes.accepts, { image: true, video: false, pdf: false });
  const answer = await eyes.see({ parts: [image, { type: "text", text: "page 1 text" }, { type: "video", data: "AAAA", mimeType: "video/mp4", fragment: "c.mp4#t=0,5" }], ask: "What fields are there?", context: "A sign-up page." }, signal());
  assert.equal(provider.state.callCount, 1);
  assert.equal(reads, 1);
  const [{ context, options }] = seen;
  assert.deepEqual(context.messages[0].content, [
    { type: "text", text: "Context: A sign-up page.\n\nWhat fields are there?" },
    { type: "image", data: image.data, mimeType: "image/png" },
    { type: "text", text: "page 1 text" },
    { type: "image", data: "AAAA", mimeType: "video/mp4" },
  ]);
  assert.equal(options.reasoning, "low");
  assert.equal(options.apiKey, SENTINEL_EYES_KEY);
  assert.equal(options.timeoutMs, SEE_TIMEOUT_MS, "120 s unless the host says otherwise");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(answer.text, "A form with two fields.");
  assert.equal(answer.model, "faux-eyes");
  assert.ok(answer.usage.input > 0 && answer.usage.output > 0);
  const expected = (answer.usage.input * PRICE.input + answer.usage.output * PRICE.output) / 1e6;
  assert.ok(Math.abs(answer.costUsd - expected) < 1e-12 && Math.abs(answer.usage.cost.total - expected) < 1e-12, "priced at the model's own rates");
  assert.ok(!JSON.stringify(answer).includes(SENTINEL_EYES_KEY), "the answer never carries the key");
});

test("every look thinks: off, an unknown level or none asks for minimal", async (t) => {
  const provider = faux();
  t.after(() => provider.unregister());
  const levels = [];
  provider.setResponses(Array.from({ length: 4 }, () => (_, options) => { levels.push(options.reasoning); return fauxAssistantMessage("ok"); }));
  for (const reasoning of ["off", "loud", undefined, "high"]) await piAiEyes(provider.getModel(), { reasoning }).see({ parts: [], ask: "q" }, signal());
  assert.deepEqual(levels, ["minimal", "minimal", "minimal", "high"]);
});

test("a model with no rates has no known price: the look costs null, never 0", async (t) => {
  const provider = faux({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  t.after(() => provider.unregister());
  provider.setResponses([fauxAssistantMessage("ok")]);
  const answer = await piAiEyes(provider.getModel()).see({ parts: [], ask: "q" }, signal());
  assert.equal(answer.costUsd, null);
});

test("a request past its timeout is cut and says so; a provider error comes back as its message, without the key", async (t) => {
  const provider = faux();
  t.after(() => provider.unregister());
  provider.setResponses([
    (_, options) => new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true })),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 503" }),
  ]);
  const eyes = piAiEyes(provider.getModel(), { apiKey: () => SENTINEL_EYES_KEY, timeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(eyes.see({ parts: [], ask: "q" }, signal()), /the faux-eyes request was cut after 0\.05 s/);
  assert.ok(Date.now() - started < 5_000);
  await assert.rejects(eyes.see({ parts: [], ask: "q" }, signal()), (error) => /upstream 503/.test(error.message) && !error.message.includes(SENTINEL_EYES_KEY));
});

test("a key callback that throws fails the look and leaves no timer behind", async (t) => {
  const provider = faux();
  t.after(() => provider.unregister());
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const before = timers();
  await assert.rejects(piAiEyes(provider.getModel(), { apiKey: () => { throw new Error("no key in this environment"); } }).see({ parts: [], ask: "q" }, signal()), /no key in this environment/);
  assert.equal(timers(), before);
  assert.equal(provider.state.callCount, 0);
});

test("the caller's cancellation stops the request; it is not reported as a timeout", async (t) => {
  const provider = faux();
  t.after(() => provider.unregister());
  provider.setResponses([(_, options) => new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true }))]);
  const caller = new AbortController();
  const pending = piAiEyes(provider.getModel()).see({ parts: [], ask: "q" }, caller.signal);
  setTimeout(() => caller.abort(), 20);
  await assert.rejects(pending, (error) => !/cut after/.test(error.message));
});

test("the host's payload hook is the provider's, and what it returns is sent; video limits say whether the model takes video", async (t) => {
  const provider = faux();
  t.after(() => provider.unregister());
  const sent = [];
  provider.setResponses([async (_, options) => { sent.push(await options.onPayload({ body: 1 }, provider.getModel())); return fauxAssistantMessage("ok"); }]);
  const hooked = [];
  const eyes = piAiEyes(provider.getModel(), { onPayload: (payload) => { hooked.push(payload); return { body: 2 }; }, limits: { video: { native: true } } });
  await eyes.see({ parts: [], ask: "q" }, signal());
  assert.deepEqual([hooked, sent], [[{ body: 1 }], [{ body: 2 }]]);
  assert.equal(eyes.accepts.video, true);
  assert.equal(eyes.limits.video.native, true);
  assert.equal(piAiEyes({ ...provider.getModel(), input: ["text"] }).accepts.image, false);
});
