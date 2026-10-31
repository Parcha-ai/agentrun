// The cap on a run on another harness, before each request: what the run has spent, plus what its requests in flight
// may still cost, plus this request's worst case must stay within it. Two requests in flight together are held, as
// pi's own cap holds them, so neither can pass the cap with the other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capBefore } from "../dist/cap.js";

// One request may cost 0.6 of the cap: a 1000-token ceiling at $600 a million output tokens is $0.60, under a $1 cap.
const model = { id: "m", api: "openai-responses", provider: "p", maxTokens: 1000, contextWindow: 8000, cost: { input: 0, output: 600, cacheRead: 0, cacheWrite: 0 } };

test("a request in flight holds its worst case: a second one sent beside it is refused, and goes once the first has answered", async () => {
  const cap = await capBefore(1, model);
  assert.equal(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 0 }), undefined, "the first goes");
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m", inputTokensMax: 0 }], inputTokensMax: 0 })?.refuse ?? "", /^spend_cap_reached: /, "the second, beside it, would pass the cap with it");
  assert.equal(cap.beforeRequest({ spentUsd: 0.3, inFlight: [], inputTokensMax: 0 }), undefined, "once the first answered, its own cost is what counts");
  assert.match(cap.beforeRequest({ spentUsd: 0.5, inFlight: [], inputTokensMax: 0 })?.refuse ?? "", /^spend_cap_reached: /, "spent and a request's worst case past the cap");
  assert.match(cap.beforeRequest({ spentUsd: null, inFlight: [], inputTokensMax: 0 })?.refuse ?? "", /spent is unknown/);
});

// $1 per million input tokens, a cache write at $2, and no output price: a request's worst case is its input bound alone.
const inputPriced = { ...model, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 2 } };

test("a request's input bound is priced, at the dearer of input and cache write: one whose input alone passes what is left of the cap is not sent", async () => {
  const cap = await capBefore(0.001, inputPriced);
  // 400 tokens at the cache write's $2 a million is $0.0008, within $0.001; 600 is $0.0012, past it.
  assert.equal(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 400 }), undefined, "an input within the cap goes");
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 600 })?.refuse ?? "", /^spend_cap_reached: .*\$0\.001200/, "an input past it is refused, at the cache-write price");
  assert.match(cap.beforeRequest({ spentUsd: 0.0005, inFlight: [], inputTokensMax: 400 })?.refuse ?? "", /^spend_cap_reached: /, "and past what is left once the run has spent");
});

test("each request in flight holds its own input bound: two that fit alone cannot pass the cap side by side", async () => {
  const cap = await capBefore(0.001, inputPriced);
  assert.equal(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 300 }), undefined, "the first goes: $0.0006");
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m", inputTokensMax: 300 }], inputTokensMax: 300 })?.refuse ?? "", /^spend_cap_reached: /, "the second, beside it, would make $0.0012");
  assert.equal(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m", inputTokensMax: 100 }], inputTokensMax: 300 }), undefined, "beside a small one it fits");
});

test("an input that could not be measured is not read as none: under a cap the request is refused", async () => {
  const cap = await capBefore(1, inputPriced);
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [] })?.refuse ?? "", /^spend_cap_reached: .*input/, "its own input unmeasured");
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m" }], inputTokensMax: 1 })?.refuse ?? "", /^spend_cap_reached: .*input/, "one in flight unmeasured");
});

test("a model serve has no price for is refused under a cap, and only under one; a model the catalog lists at $0 is a known $0 and passes", async () => {
  for (const unpriced of [await capBefore(1, undefined), await capBefore(1, model, { listed: false })]) {
    assert.match(unpriced?.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 0 })?.refuse ?? "", /^spend_cap_reached: .*no price.*out of budget/, "refused under a cap");
  }
  assert.equal(await capBefore(undefined, undefined), undefined, "no cap, no refusal");
  assert.equal(await capBefore(undefined, model, { listed: false }), undefined, "no cap, no refusal, priced or not");
  const free = await capBefore(0.000001, { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(free.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 1_000_000 }), undefined, "a listed $0 model passes any cap");
});
