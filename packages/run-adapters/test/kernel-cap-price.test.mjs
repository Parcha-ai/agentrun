// The kernel cap's one pricing rule, the same for every harness: a request's input bound (one token per UTF-8 byte of what
// is sent, plus what its provider adds and its hosted tools read) at the dearer of the input and cache-write prices, the
// worst case: whatever the session cached before, every input token is priced uncached, so no request passes the cap, a
// cache miss included. Its output held at what it is sent with, its thinking budget included. A model with no price, and
// a priced model with no output ceiling, cannot be kept within a cap: under one they are refused for good.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapRefused, pricingOf } from "../dist/kernel/cap/index.js";
import { providerInputOverhead } from "../dist/host/index.js";
import { capOn, FREE, GPT, modelRequest, SONNET, T0, UNPRICED, usd } from "./kernel-cap-support.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ""} ${actual} vs ${expected}`);
/** A session's previous request that read 90% of its input from the cache: a field the cap no longer reads. */
const warm = (overrides = {}) => ({ model: SONNET.id, cachedTokens: 90_000, inputTokens: 10_000, boundTokens: 100_000, endedAt: T0 - 1_000, ...overrides });

test("the input bound is priced at the dearer of input and cache write: an input that alone passes what is left is not sent", async () => {
  const { cap } = capOn(0.37);
  // 100,000 tokens at $3.75 (cache write, dearer than input's $3) is $0.375: past the $0.37 cap before any output.
  await assert.rejects(cap.admit(modelRequest(SONNET, 100_000)), (error) => error instanceof CapRefused && !error.forGood);
  const { cap: wide } = capOn(10);
  const admitted = await wide.admit(modelRequest(GPT, 100_000, 1_000));
  near(admitted.heldUsd, usd(100_000, 1.25) + usd(1_000, 10), "no cache-write price: the input price");
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
  const { cap } = capOn(10);
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 1_000, { extraInputTokens: 8 * 25_000 }));
  near(admitted.heldUsd, usd(210_000, 3.75) + usd(1_000, 15));
});

test("a request's least is the figure admit refuses it below: its input uncached, whatever the session cached before", async () => {
  const { cap } = capOn(10);
  const cold = modelRequest(SONNET, 10_000);
  near(cap.leastUsd(cold), usd(10_000, 3.75) + usd(1_024, 15), "uncached, 1,024 answer tokens");
  const hot = modelRequest(SONNET, 10_000, 4_096, { recent: [warm({ cachedTokens: 9_000, inputTokens: 1_000, boundTokens: 10_000 })] });
  near(cap.leastUsd(hot), cap.leastUsd(cold), "a cached session's request: the same");
  const least = cap.leastUsd(cold);
  await assert.rejects(capOn(least - 0.0001).cap.admit(modelRequest(SONNET, 10_000)), CapRefused);
  await capOn(least).cap.admit(modelRequest(SONNET, 10_000));
});

/** A run of growing Sonnet requests under a $0.50 cap, each billed by `billed(bound, cached, output)`, until the cap
 *  refuses the next: what it spent. */
async function cappedRun(billed) {
  const { cap, clock } = capOn(0.5);
  let previous = 0;
  let bound = 2_000;
  for (;;) {
    const request = modelRequest(SONNET, bound, 1_100);
    let admitted;
    try {
      admitted = await cap.admit(request);
    } catch (error) {
      assert.ok(error instanceof CapRefused && !error.forGood, String(error));
      break;
    }
    const output = admitted.outputTokensMax ?? 1_100;
    const cost = billed(bound, previous, output);
    assert.ok(cost <= admitted.heldUsd + 1e-12, `request of ${bound} billed ${cost}, past its hold ${admitted.heldUsd}`);
    clock.now += 1_000;
    await cap.settle(request.id, { end: "answered", usd: cost });
    previous = bound;
    bound += 500;
  }
  return cap.spentUsd();
}

test("a ~90% cached run and the same run with every cache missed both stop at a $0.50 cap and never pass it", async () => {
  // A cache hit: the previous bound read from the cache, the rest written, and the output it was sent with.
  const hit = await cappedRun((bound, cached, output) => usd(cached, 0.3) + usd(bound - cached, 3.75) + usd(output, 15));
  // Every request missed: its whole input written to the cache.
  const missed = await cappedRun((bound, _cached, output) => usd(bound, 3.75) + usd(output, 15));
  assert.ok(hit <= 0.5 + 1e-12, `cached: spent ${hit}`);
  assert.ok(missed <= 0.5 + 1e-12, `missed: spent ${missed}`);
  assert.ok(missed >= 0.45, `the run that missed used its cap: spent ${missed}`);
  assert.ok(hit > 0, "the cached run ran");
});

test("a request whose session read the cache is held at the worst case all the same, with no bound beside it", async () => {
  const { cap } = capOn(10);
  const admitted = await cap.admit(modelRequest(SONNET, 100_000, 1_000, { recent: [warm()] }));
  near(admitted.heldUsd, usd(100_000, 3.75) + usd(1_000, 15));
  assert.equal("boundUsd" in admitted, false);
});

test("a request is held at the output it is sent with, its thinking budget included", async () => {
  const { cap } = capOn(10);
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 4_096, { thinkingBudget: 8_000 }));
  assert.equal(admitted.outputTokensMax, 12_096);
  near(admitted.heldUsd, usd(10_000, 3.75) + usd(12_096, 15));
});

test("the input adds the provider's server-side tokens from the proxy's table: tools and an image held the same on every harness", async () => {
  const { cap } = capOn(10);
  const shape = { tools: true, toolChoice: "auto", images: [{ bytes: 0 }] };
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 1_000, { shape }));
  // Its image at its model's provider's figure (a Claude model: Anthropic's per-image maximum, its size unread).
  near(admitted.heldUsd, usd(10_000 + providerInputOverhead("anthropic-messages", { ...shape, model: SONNET.id }), 3.75) + usd(1_000, 15));
  assert.equal(providerInputOverhead("anthropic-messages", { ...shape, model: SONNET.id }), 675 + 4784);
});

test("a gateway or provider with no documented figure is priced and sent, never refused for its API", async () => {
  const { cap } = capOn(10);
  const gateway = { ...GPT, id: "gateway-model", api: "openai-completions" };
  const elsewhere = { ...GPT, id: "elsewhere", api: "some-new-api" };
  await cap.admit(modelRequest(gateway, 10_000, 1_000, { shape: { tools: true, images: [] } }));
  await cap.admit(modelRequest(elsewhere, 10_000, 1_000, { shape: { tools: true, images: [] } }));
});

test("a tool's own request adds its hosted allowance and most fee: web search at 5 searches of 25,000 tokens and 5 searches' fee", async () => {
  const { cap } = capOn(10);
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 1_000, { extraInputTokens: 5 * 25_000, feeUsd: 5 * 0.01 }));
  near(admitted.heldUsd, usd(135_000, 3.75) + usd(1_000, 15) + 0.05);
});

test("a priced output with no ceiling is refused whatever is asked; a free output with none passes; with no cap nothing is", async () => {
  const unbounded = { ...GPT, id: "unbounded", outputCeiling: null };
  await assert.rejects(capOn(10).cap.admit(modelRequest(unbounded, 1_000, 100)), (error) => error instanceof CapRefused && error.forGood && /no output ceiling/.test(error.message));
  await capOn(10).cap.admit(modelRequest({ ...FREE, outputCeiling: null }, 1_000, 100));
  await capOn(undefined).cap.admit(modelRequest(unbounded, 1_000, 100));
});

// A price with tiers, as the catalog gives gpt-6.1-sol's: past 272,000 input tokens, the whole request at the tier's
// rates, as pi-ai's calculateCost prices it (the parity with that function is serve's kernel-cap-tiers-parity test, on
// the catalog's own entry).
const SOL = Object.freeze({
  id: "gpt-6.1-sol", api: "openai-responses", outputCeiling: 128_000,
  price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
});

test("a price with tiers: a request whose input passes a tier's threshold is priced at that tier, whole, uncached", () => {
  const price = pricingOf(SOL.price);
  near(price(272_000, 1_024), usd(272_000, 2.5) + usd(1_024, 10), "at the threshold, the base rates");
  near(price(300_000, 1_024), usd(300_000, 5) + usd(1_024, 15), "past it, the tier's rates for all of it");
});

test("the hold of a request past a tier's threshold is the tiered price, never the base one", async () => {
  const admitted = await capOn(10).cap.admit(modelRequest(SOL, 300_000, 4_096));
  near(admitted.heldUsd, usd(300_000, 5) + usd(4_096, 15));
});

test("a run whose cap the tiered price passes parks, where the base price would have let it pass its cap by up to 2x", async () => {
  // Base: 300,000 at $2.50 and 1,024 out at $10 is $0.76, under the $1 cap. Tiered: $1.51536, over it.
  await assert.rejects(capOn(1).cap.admit(modelRequest(SOL, 300_000, 4_096)), (error) => {
    assert.ok(error instanceof CapRefused && !error.forGood, String(error));
    near(error.figures.needsUsd, usd(300_000, 5) + usd(1_024, 15), "the need at the tier's rates");
    return true;
  });
});
