// A model request admitted beside a keep-back (JudgeState.keepUsd: serve's wrap-up reserve) is sent with the most output
// whose hold (its worst case: its whole input uncached) leaves the keep-back free, so a tool call it makes while it
// streams still finds room for the steps after it. When even its least and the keep-back do not fit, it gets the most
// what is left buys, as with none: it may be the run's answer. Either way its hold is at most what is left.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beforeRequestOf, capRule, CapRefused, FIT_TOLERANCE, pricingOf, requestFigures, typicalCost } from "../dist/kernel/cap/index.js";

/** gpt-6.1-sol as the tests' stand-in prices it: $2 in, $10 out, $2.50 a cache write a million tokens (as OpenRouter
 *  lists it), a cache read at a tenth of the input; Codex's Responses API, its output at most 128,000. */
const SOL = Object.freeze({ id: "gpt-6.1-sol", api: "openai-responses", price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, outputCeiling: 128_000, reasoning: true });

/** Request `k` of a Codex-shaped conversation: a 10,000-token prompt growing 1,100 a request, its bound its bytes (4 a
 *  token), asking 32,000 output tokens and needing 3,072 (low effort). */
function codexRequest(k) {
  const prompt = (n) => 10_000 + 1_100 * n;
  return { kind: "model", id: `turn-${k}`, model: SOL, inputTokens: prompt(k) * 4, outputAsked: 32_000, outputTokensLeast: 3_072 };
}
const state = (capUsd, spentUsd, keepUsd) => ({ capUsd, spentUsd, heldUsd: 0, ...(keepUsd === undefined ? {} : { keepUsd }) });
/** Serve's reserve for `request` (wrap-up.ts reserveFor): one typical step (step 0's, before any is priced) and its least. */
const reserveOf = (request, costs = []) => {
  const figures = requestFigures(request);
  return typicalCost(costs, figures.step0Usd) + figures.leastUsd;
};
// The cap the keep-back clamps under: request 3's whole input uncached ($0.133), its least answer and the reserve fit it
// with room to spare, and its whole 32,000-token ask beside the reserve does not.
const CAP = 0.7;

test("a $0.70 Codex request keeps the reserve free: its hold and the reserve fit what is left, where it held 32,000 tokens without", () => {
  const request = codexRequest(3);
  const keepUsd = reserveOf(request);
  const without = capRule.judge(request, state(CAP, 0.03));
  const kept = capRule.judge(request, state(CAP, 0.03, keepUsd));
  assert.equal(without.outputTokensMax, 32_000, "without a keep-back it is held at its whole ask");
  assert.ok(0.03 + without.heldUsd + keepUsd > CAP, `without, a tool call mid-stream finds no room: ${0.03 + without.heldUsd + keepUsd}`);
  assert.ok(kept.outputTokensMax < 32_000 && kept.outputTokensMax >= 3_072, `clamped above its least: ${kept.outputTokensMax}`);
  assert.ok(0.03 + kept.heldUsd + keepUsd <= CAP + FIT_TOLERANCE, `its hold and the reserve fit: ${0.03 + kept.heldUsd + keepUsd}`);
  assert.ok(0.03 + kept.heldUsd + keepUsd > CAP - 2 * SOL.price.output / 1e6, "the most output that does, to the token");
  console.log(`# $${CAP} cap, $0.03 spent, gpt-6.1-sol request 3: held $${without.heldUsd.toFixed(4)} at ${without.outputTokensMax} tokens before; $${kept.heldUsd.toFixed(4)} at ${kept.outputTokensMax} with the reserve $${keepUsd.toFixed(4)} kept`);
});

test("at $0.50 with $0.03 spent, request 3's least and the reserve do not fit: it is not parked, it gets the most what is left buys", () => {
  const request = codexRequest(3);
  const keepUsd = reserveOf(request);
  const kept = capRule.judge(request, state(0.5, 0.03, keepUsd));
  const without = capRule.judge(request, state(0.5, 0.03));
  assert.deepEqual({ out: kept.outputTokensMax, held: kept.heldUsd }, { out: without.outputTokensMax, held: without.heldUsd });
  assert.ok(0.03 + kept.heldUsd <= 0.5 + FIT_TOLERANCE, `never past the cap: ${0.03 + kept.heldUsd}`);
});

test("the hold and what a stop counts are priced at the output sent, its whole input uncached, as without a keep-back", () => {
  const request = codexRequest(3);
  const kept = capRule.judge(request, state(CAP, 0.03, reserveOf(request)));
  const pricing = pricingOf(SOL.price);
  assert.ok(Math.abs(kept.heldUsd - pricing(request.inputTokens, kept.outputTokensMax)) < 1e-12, "held at its input uncached and the output sent");
  assert.equal("boundUsd" in kept, false, "no bound beside it");
  assert.ok(kept.stoppedUsd(10) <= kept.heldUsd && kept.stoppedUsd(1e9) === kept.heldUsd);
});

test("when its least and the keep-back do not fit, it is admitted as with none: the most what is left buys", () => {
  const request = codexRequest(3);
  for (const keepUsd of [0.3, 0.45, 10]) {
    const kept = capRule.judge(request, state(0.5, 0.1, keepUsd));
    const without = capRule.judge(request, state(0.5, 0.1));
    assert.deepEqual({ out: kept.outputTokensMax, held: kept.heldUsd }, { out: without.outputTokensMax, held: without.heldUsd }, `keep $${keepUsd}`);
  }
});

test("no keep-back, $0 or one that is not a figure is the rule as it was", () => {
  const request = codexRequest(3);
  const without = capRule.judge(request, state(CAP, 0.03));
  for (const keepUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const judged = capRule.judge(request, state(CAP, 0.03, keepUsd));
    assert.equal(judged.outputTokensMax, without.outputTokensMax, `keep ${keepUsd}`);
    assert.equal(judged.heldUsd, without.heldUsd, `keep ${keepUsd}`);
  }
});

test("a request whose least does not fit is refused in the same words, keep-back or not", () => {
  const request = codexRequest(3);
  const words = (keepUsd) => {
    try {
      capRule.judge(request, state(0.5, 0.49, keepUsd));
    } catch (error) {
      assert.ok(error instanceof CapRefused && !error.forGood);
      return error.message;
    }
    assert.fail("admitted");
  };
  assert.equal(words(0.05), words(undefined));
});

test("over every spend from $0 to the cap, a hold is never past what is left and a kept one leaves the keep-back free", () => {
  const request = codexRequest(5);
  const keepUsd = reserveOf(request);
  for (let spent = 0; spent <= CAP; spent += 0.005) {
    let judged;
    try {
      judged = capRule.judge(request, state(CAP, spent, keepUsd));
    } catch (error) {
      assert.ok(error instanceof CapRefused);
      continue;
    }
    assert.ok(spent + judged.heldUsd <= CAP + FIT_TOLERANCE, `held past the cap at $${spent}`);
    const room = CAP - spent;
    const fits = requestFigures(request).leastUsd + keepUsd <= room + FIT_TOLERANCE;
    if (fits) assert.ok(spent + judged.heldUsd + keepUsd <= CAP + FIT_TOLERANCE, `kept at $${spent}`);
  }
});

// A Codex run at a $0.50 cap, from its journal: gpt-6.1-sol requests of 46,059, 46,883 and 62,658 bytes, the first two
// answered at $0.025116 and $0.0018695. Its request 3 was held at its whole 32,000 tokens with no room left for the
// wrap-up's reserve, so the tool call Codex started while it streamed was refused. Held at its worst case with the reserve
// kept back, it is sent with fewer tokens, above its least, and the call passes.
test("the live run's request 3, its tool call made while it streamed: kept back at its worst case, it is clamped, never parked, and the reserve fits", () => {
  const LIVE_CAP = 0.5;
  const costs = [0.025116, 0.0018695];
  const spentUsd = costs[0] + costs[1];
  const request = { kind: "model", id: "turn-3", model: SOL, inputTokens: 62_658, outputAsked: 32_000, outputTokensLeast: 3_072 };
  const figures = requestFigures(request);
  const reserve = typicalCost(costs, figures.step0Usd) + figures.leastUsd;
  const before = capRule.judge(request, state(LIVE_CAP, spentUsd));
  assert.ok(spentUsd + before.heldUsd + reserve > LIVE_CAP, "without the keep-back, no room for the reserve: the call refused");
  const after = capRule.judge(request, state(LIVE_CAP, spentUsd, reserve));
  assert.ok(after.outputTokensMax >= 3_072 && after.outputTokensMax < 32_000, `sent with fewer tokens: ${after.outputTokensMax}`);
  assert.ok(spentUsd + after.heldUsd + reserve <= LIVE_CAP + FIT_TOLERANCE, "its hold and the reserve fit: the call passes");
  assert.ok(Math.abs(after.heldUsd - pricingOf(SOL.price)(62_658, after.outputTokensMax)) < 1e-12, "its hold is a whole cache miss: it cannot pass the cap");
  console.log(`# request 3: held $${before.heldUsd.toFixed(4)} at ${before.outputTokensMax} before; $${after.heldUsd.toFixed(4)} at ${after.outputTokensMax} with $${reserve.toFixed(4)} kept`);
});

test("beforeRequestOf asks the host's keep-back for each model request, priced as the rule prices it, and applies it", async () => {
  const told = [];
  const before = beforeRequestOf({
    capUsd: () => CAP,
    modelOf: () => SOL,
    keepBackUsd: (request, asked) => (told.push({ turn: request.turn, asked }), reserveOf(asked)),
  });
  const { inputTokens } = codexRequest(3);
  const answer = await before({ model: "openai/gpt-6.1-sol", spentUsd: 0.03, inFlight: [], inputTokensMax: inputTokens, outputTokensAsked: 32_000, outputTokensLeast: 3_072, turn: 4, maxTurns: null, key: "k", label: "k" });
  assert.equal(told.length, 1);
  assert.equal(told[0].turn, 4);
  assert.equal(told[0].asked.inputTokens, inputTokens);
  assert.equal("recent" in told[0].asked, false, "priced uncached: no session history in what the rule prices");
  assert.ok(answer.outputTokensMax < 32_000);
  assert.ok(0.03 + answer.holdUsd + reserveOf(told[0].asked) <= CAP + FIT_TOLERANCE);
  const plain = await beforeRequestOf({ capUsd: () => CAP, modelOf: () => SOL, keepBackUsd: () => undefined })({ model: "gpt-6.1-sol", spentUsd: 0.03, inFlight: [], inputTokensMax: inputTokens, outputTokensAsked: 32_000, outputTokensLeast: 3_072, turn: 4, maxTurns: null, key: "k", label: "k" });
  assert.equal(plain.outputTokensMax, 32_000, "a host that keeps none back gets the rule as it was");
});
