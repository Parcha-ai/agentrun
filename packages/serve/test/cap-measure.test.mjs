// A run with no cap still measures each request's worst case, so a cost no one knows has a bound (costbound/1): pi's
// requests carry it to their marks (measureModels), and another harness's runner gets it from a guard that refuses
// nothing (measureBefore). One formula with the cap's (requestWorst, capBefore's worstOf). Neither ever refuses or throws:
// an unpriced model, a model with no output ceiling, an input that cannot be measured, or an error while measuring, sends
// the request with no figure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { capBefore, capModels, HELD_USD, measureBefore, measureModels } from "../dist/cap.js";

/** Models that record each request's options, and answer it at once. */
function recordingModels() {
  const sent = [];
  const send = (model, context, options) => {
    sent.push(options ?? {});
    const events = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 };
    events.push({ type: "done", reason: "stop", message });
    events.end(message);
    return events;
  };
  return { sent, models: { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result(), getModel: () => undefined } };
}

const model = (cost, ceiling = { maxTokens: 1_000, contextWindow: 128_000 }) => ({ id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: true, input: ["text"], cost, ...ceiling });
const priced = model({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
const noOverhead = () => 0;

test("an uncapped pi request carries the worst case a cap would hold for it, by the same formula", async () => {
  const capped = recordingModels();
  await (await capModels(capped.models, 1_000, 0, { overhead: noOverhead })).streamSimple(priced, context).result();
  const measured = recordingModels();
  await (await measureModels(measured.models, { overhead: noOverhead })).streamSimple(priced, context).result();
  const held = capped.sent[0][HELD_USD];
  assert.ok(typeof held === "number" && held > 0, String(held));
  assert.equal(measured.sent[0][HELD_USD], held, "the same figure the cap holds");
  // Every way a request goes out is measured.
  const each = recordingModels();
  const wrapped = await measureModels(each.models, { overhead: noOverhead });
  await wrapped.stream(priced, context).result();
  await wrapped.complete(priced, context);
  await wrapped.completeSimple(priced, context);
  assert.deepEqual(each.sent.map((options) => options[HELD_USD]), [held, held, held]);
});

test("an uncapped pi request with no figure to measure goes out with none: an unpriced model, no output ceiling, an input that cannot be measured", async () => {
  const cases = [
    [priced, { unpriced: new Set(["m"]), overhead: noOverhead }],
    [model({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, { maxTokens: 0, contextWindow: 0 }), { overhead: noOverhead }],
    [priced, { overhead: () => undefined }],
  ];
  for (const [which, options] of cases) {
    const { sent, models } = recordingModels();
    const answer = await (await measureModels(models, options)).streamSimple(which, context).result();
    assert.equal(answer.stopReason, "stop", "sent and answered, never refused");
    assert.equal(HELD_USD in sent[0], false);
  }
});

test("an error while measuring an uncapped pi request drops only the figure: the request still goes out", async () => {
  const { sent, models } = recordingModels();
  const answer = await (await measureModels(models, { overhead: () => { throw new Error("measuring broke"); } })).streamSimple(priced, context).result();
  assert.deepEqual([answer.stopReason, sent.length, HELD_USD in sent[0]], ["stop", 1, false]);
});

test("an uncapped harness's guard refuses nothing, even an unknown spend, and gives each request the worst case a cap's guard holds", async () => {
  const capped = await capBefore(1_000, priced);
  const measured = await measureBefore(priced);
  for (const request of [{ spentUsd: 0, inFlight: [], inputTokensMax: 500 }, { spentUsd: null, inFlight: [], inputTokensMax: 500 }, { spentUsd: 1e9, inFlight: [{}], inputTokensMax: undefined }]) {
    assert.equal(measured.beforeRequest(request), undefined, JSON.stringify(request));
  }
  assert.equal(measured.worstOf({ inputTokensMax: 500 }), capped.worstOf({ inputTokensMax: 500 }));
  assert.equal(measured.worstOf({ inputTokensMax: undefined }), undefined, "an input it cannot measure: no figure");
});

test("an uncapped harness on a model it cannot price has no guard, and an error while measuring gives no figure, never a throw", async () => {
  assert.equal(await measureBefore(undefined), undefined);
  assert.equal(await measureBefore(priced, { listed: false }), undefined, "unpriced");
  assert.equal(await measureBefore(model({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, { maxTokens: 0, contextWindow: 0 })), undefined, "no output ceiling");
  // A model whose price cannot be read once a request is measured: the figure is dropped, the request is not refused.
  let broken = false;
  const breaking = { ...priced, get cost() { if (broken) throw new Error("price broke"); return priced.cost; } };
  const guard = await measureBefore(breaking);
  broken = true;
  assert.equal(guard.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 500 }), undefined);
  assert.equal(guard.worstOf({ inputTokensMax: 500 }), undefined);
});
