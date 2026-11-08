// The kernel cap's one pricing rule, the same for every harness: a request's input bound (one token per UTF-8 byte of what
// is sent, plus what its provider adds and its hosted tools read) at the dearer of the input and cache-write prices; under
// "expected" (the default) the previous request's cache read at the cache-read price when it ended under 4 minutes ago on
// the same model, so only a cache miss can pass the cap, by at most the request's bound; under "strict" every token
// uncached. Its output held at what it is sent with, its thinking budget included. A model with no price, and a priced
// model with no output ceiling, cannot be kept within a cap: under one they are refused for good.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CACHE_WARM_MS, CapRefused } from "../dist/kernel/cap/index.js";
import { providerInputOverhead } from "../dist/host/index.js";
import { capOn, FREE, GPT, modelRequest, SONNET, T0, UNPRICED, usd } from "./kernel-cap-support.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ""} ${actual} vs ${expected}`);
const warm = (overrides = {}) => ({ model: SONNET.id, cachedTokens: 90_000, inputTokens: 10_000, boundTokens: 100_000, endedAt: T0 - 1_000, ...overrides });

test("the input bound is priced at the dearer of input and cache write: an input that alone passes what is left is not sent", async () => {
  const { cap } = capOn(0.37);
  // 100,000 tokens at $3.75 (cache write, dearer than input's $3) is $0.375: past the $0.37 cap before any output.
  await assert.rejects(cap.admit(modelRequest(SONNET, 100_000)), (error) => error instanceof CapRefused && !error.forGood);
  const { cap: wide } = capOn(10, { mode: "strict" });
  const admitted = await wide.admit(modelRequest(GPT, 100_000, 1_000));
  near(admitted.worstUsd, usd(100_000, 1.25) + usd(1_000, 10), "no cache-write price: the input price");
});

test("an unpriced model is refused under a cap and only under one; a catalog $0 is a known $0", async () => {
  const { cap } = capOn(1);
  await assert.rejects(cap.admit(modelRequest(UNPRICED, 1_000)), (error) => error instanceof CapRefused && error.forGood && /no price/.test(error.message));
  const { cap: none } = capOn(undefined);
  await none.admit(modelRequest(UNPRICED, 1_000));
  const free = await cap.admit(modelRequest(FREE, 1_000));
  assert.equal(free.heldUsd, 0);
});

test("a harness's own search adds its allowance to the request's bound: 8 searches of 25,000 tokens", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 1_000, { extraInputTokens: 8 * 25_000 }));
  near(admitted.worstUsd, usd(210_000, 3.75) + usd(1_000, 15));
});

test("a request's least is the figure admit refuses it below: uncached with no previous request, cache-read with one", async () => {
  const { cap } = capOn(10);
  const cold = modelRequest(SONNET, 10_000);
  near(cap.leastUsd(cold), usd(10_000, 3.75) + usd(1_024, 15), "uncached, 1,024 answer tokens");
  const hot = modelRequest(SONNET, 10_000, 4_096, { previous: warm({ cachedTokens: 9_000, inputTokens: 1_000, boundTokens: 10_000 }) });
  near(cap.leastUsd(hot), usd(9_000, 0.3) + usd(1_000, 3.75) + usd(1_024, 15), "read from the cache");
  const least = cap.leastUsd(cold);
  await assert.rejects(capOn(least - 0.0001).cap.admit(modelRequest(SONNET, 10_000)), CapRefused);
  await capOn(least).cap.admit(modelRequest(SONNET, 10_000));
});

test("expected mode on a ~90% cached run spends at least 90% of a $0.50 cap and never passes it", async () => {
  const { cap, clock } = capOn(0.5);
  let previous;
  let bound = 2_000;
  for (;;) {
    const request = modelRequest(SONNET, bound, 1_100, previous ? { previous } : {});
    let admitted;
    try {
      admitted = await cap.admit(request);
    } catch (error) {
      assert.ok(error instanceof CapRefused, String(error));
      break;
    }
    // A cache hit: the previous bound read from the cache, the rest written, and the output it was sent with.
    const cached = previous ? previous.boundTokens : 0;
    const output = admitted.outputTokensMax ?? 1_100;
    const cost = usd(cached, 0.3) + usd(bound - cached, 3.75) + usd(output, 15);
    clock.now += 1_000;
    await cap.settle(request.id, { end: "answered", usd: cost });
    previous = { model: SONNET.id, cachedTokens: cached, inputTokens: bound - cached, boundTokens: bound, endedAt: clock.now };
    bound += 500;
  }
  assert.ok(cap.spentUsd() >= 0.45, `spent ${cap.spentUsd()}`);
  assert.ok(cap.spentUsd() <= 0.5 + 1e-12, `spent ${cap.spentUsd()}`);
});

test("strict mode holds the worst case with no bound", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(SONNET, 100_000, 1_000, { previous: warm() }));
  near(admitted.heldUsd, admitted.worstUsd);
  assert.equal(admitted.boundUsd, 0);
});

test("the previous cache counts under 4 minutes: at 3:59.999 the expected cost, at 4:00.001 the worst case", async () => {
  assert.equal(CACHE_WARM_MS, 240_000);
  const { cap, clock } = capOn(10);
  const fresh = await cap.admit(modelRequest(SONNET, 100_000, 1_000, { previous: warm({ endedAt: clock.now - (CACHE_WARM_MS - 1) }) }));
  near(fresh.heldUsd, usd(90_000, 0.3) + usd(10_000, 3.75) + usd(1_000, 15), "expected");
  near(fresh.boundUsd, fresh.worstUsd - fresh.heldUsd, "the bound is what a miss can add");
  const stale = await cap.admit(modelRequest(SONNET, 100_000, 1_000, { previous: warm({ endedAt: clock.now - (CACHE_WARM_MS + 1) }) }));
  near(stale.heldUsd, stale.worstUsd);
  assert.equal(stale.boundUsd, 0);
});

test("another model than the previous answer's counts no cache: worst case, no bound", async () => {
  const { cap } = capOn(10);
  const admitted = await cap.admit(modelRequest(SONNET, 100_000, 1_000, { previous: warm({ model: GPT.id }) }));
  near(admitted.heldUsd, admitted.worstUsd);
  assert.equal(admitted.boundUsd, 0);
});

test("a request is held at the output it is sent with, its thinking budget included", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 4_096, { thinkingBudget: 8_000 }));
  assert.equal(admitted.outputTokensMax, 12_096);
  near(admitted.worstUsd, usd(10_000, 3.75) + usd(12_096, 15));
});

test("the input adds the provider's server-side tokens from the proxy's table: tools and an image held the same on every harness", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const shape = { tools: true, toolChoice: "auto", images: 1 };
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 1_000, { shape }));
  near(admitted.worstUsd, usd(10_000 + providerInputOverhead("anthropic-messages", shape), 3.75) + usd(1_000, 15));
});

test("a gateway or provider with no documented figure is priced and sent, never refused for its API", async () => {
  const { cap } = capOn(10);
  const gateway = { ...GPT, id: "gateway-model", api: "openai-completions" };
  const elsewhere = { ...GPT, id: "elsewhere", api: "some-new-api" };
  await cap.admit(modelRequest(gateway, 10_000, 1_000, { shape: { tools: true, images: 0 } }));
  await cap.admit(modelRequest(elsewhere, 10_000, 1_000, { shape: { tools: true, images: 0 } }));
});

test("a tool's own request adds its hosted allowance and most fee: web search at 5 searches of 25,000 tokens and 5 searches' fee", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 1_000, { extraInputTokens: 5 * 25_000, feeUsd: 5 * 0.01 }));
  near(admitted.worstUsd, usd(135_000, 3.75) + usd(1_000, 15) + 0.05);
});

test("a priced output with no ceiling is refused whatever is asked; a free output with none passes; with no cap nothing is", async () => {
  const unbounded = { ...GPT, id: "unbounded", outputCeiling: null };
  await assert.rejects(capOn(10).cap.admit(modelRequest(unbounded, 1_000, 100)), (error) => error instanceof CapRefused && error.forGood && /no output ceiling/.test(error.message));
  await capOn(10).cap.admit(modelRequest({ ...FREE, outputCeiling: null }, 1_000, 100));
  await capOn(undefined).cap.admit(modelRequest(unbounded, 1_000, 100));
});
