// A model request admitted beside a keep-back (JudgeState.keepUsd: serve's wrap-up reserve) is sent with the most output
// whose worst case (its hold and the cache miss its bound covers) leaves the keep-back free, so a tool call it makes while
// it streams still finds room for the steps after it. When even its least and the keep-back do not fit, it gets the most
// what is left buys, as with none: it may be the run's answer. Either way its hold is at most what is left.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beforeRequestOf, capRule, CapRefused, FIT_TOLERANCE, pricingOf, requestFigures, typicalCost } from "../dist/kernel/cap/index.js";
import { T0 } from "./kernel-cap-support.mjs";

/** gpt-6.1-sol as the tests' stand-in prices it: $2 in, $10 out, $2.50 a cache write a million tokens (as OpenRouter
 *  lists it), a cache read at a tenth of the input; Codex's Responses API, its output at most 128,000. */
const SOL = Object.freeze({ id: "gpt-6.1-sol", api: "openai-responses", price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, outputCeiling: 128_000, reasoning: true });

/** Request `k` of a Codex-shaped conversation: a 10,000-token prompt growing 1,100 a request, its bound its bytes (4 a
 *  token), asking 32,000 output tokens and needing 3,072 (low effort), its previous request answered `ago` ms before. */
function codexRequest(k, { ago = 10_000 } = {}) {
  const prompt = (n) => 10_000 + 1_100 * n;
  const previous = k === 0 ? undefined : { model: SOL.id, cachedTokens: prompt(k - 1) - 3, inputTokens: 3, boundTokens: prompt(k - 1) * 4, endedAt: T0 - ago };
  return { kind: "model", id: `turn-${k}`, model: SOL, inputTokens: prompt(k) * 4, outputAsked: 32_000, outputTokensLeast: 3_072, ...(previous ? { previous } : {}) };
}
const state = (capUsd, spentUsd, keepUsd) => ({ capUsd, spentUsd, heldUsd: 0, mode: "expected", now: T0, ...(keepUsd === undefined ? {} : { keepUsd }) });
/** Serve's reserve for `request` (wrap-up.ts reserveFor): one typical step (step 0's, before any is priced) and its least. */
const reserveOf = (request, costs = []) => {
  const figures = requestFigures(request, "expected", T0);
  return typicalCost(costs, figures.step0Usd) + figures.leastUsd;
};

test("a $0.50 Codex request keeps the reserve free: its worst case and the reserve fit what is left, where it held 32,000 tokens without", () => {
  const request = codexRequest(3);
  const keepUsd = reserveOf(request);
  const without = capRule.judge(request, state(0.5, 0.03));
  const kept = capRule.judge(request, state(0.5, 0.03, keepUsd));
  assert.equal(without.outputTokensMax, 32_000, "without a keep-back it is held at its whole ask");
  assert.ok(0.03 + without.worstUsd + keepUsd > 0.5, `without, a tool call mid-stream finds no room: ${0.03 + without.worstUsd + keepUsd}`);
  assert.ok(kept.outputTokensMax < 32_000 && kept.outputTokensMax >= 3_072, `clamped above its least: ${kept.outputTokensMax}`);
  assert.ok(0.03 + kept.worstUsd + keepUsd <= 0.5 + FIT_TOLERANCE, `its worst and the reserve fit: ${0.03 + kept.worstUsd + keepUsd}`);
  assert.ok(0.03 + kept.worstUsd + keepUsd > 0.5 - 2 * SOL.price.output / 1e6, "the most output that does, to the token");
  assert.ok(kept.heldUsd <= 0.5 - 0.03, "never past the cap");
  console.log(`# $0.50 cap, $0.03 spent, gpt-6.1-sol request 3: held $${without.heldUsd.toFixed(4)} at ${without.outputTokensMax} tokens before; $${kept.heldUsd.toFixed(4)} at ${kept.outputTokensMax} with the reserve $${keepUsd.toFixed(4)} kept`);
});

test("hold, bound and what a stop counts are priced at the output sent, as without a keep-back", () => {
  const request = codexRequest(3);
  const kept = capRule.judge(request, state(0.5, 0.03, reserveOf(request)));
  const pricing = pricingOf(SOL.price);
  const input = { cached: request.previous.cachedTokens, fresh: request.previous.inputTokens + (request.inputTokens - request.previous.boundTokens) };
  assert.ok(Math.abs(kept.heldUsd - pricing(input, kept.outputTokensMax)) < 1e-12, "held at its warm input and the output sent");
  assert.ok(Math.abs(kept.worstUsd - pricing({ cached: 0, fresh: request.inputTokens }, kept.outputTokensMax)) < 1e-12, "its worst all uncached at that output");
  assert.ok(Math.abs(kept.boundUsd - (kept.worstUsd - kept.heldUsd)) < 1e-12);
  assert.ok(kept.stoppedUsd(10) <= kept.heldUsd && kept.stoppedUsd(1e9) === kept.heldUsd);
});

test("when its least and the keep-back do not fit, it is admitted as with none: the most what is left buys", () => {
  const request = codexRequest(3);
  for (const keepUsd of [0.3, 0.45, 10]) {
    const kept = capRule.judge(request, state(0.5, 0.1, keepUsd));
    const without = capRule.judge(request, state(0.5, 0.1));
    assert.deepEqual({ out: kept.outputTokensMax, held: kept.heldUsd, bound: kept.boundUsd }, { out: without.outputTokensMax, held: without.heldUsd, bound: without.boundUsd }, `keep $${keepUsd}`);
  }
});

test("no keep-back, $0 or one that is not a figure is the rule as it was", () => {
  const request = codexRequest(3);
  const without = capRule.judge(request, state(0.5, 0.03));
  for (const keepUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const judged = capRule.judge(request, state(0.5, 0.03, keepUsd));
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
  for (let spent = 0; spent <= 0.5; spent += 0.005) {
    let judged;
    try {
      judged = capRule.judge(request, state(0.5, spent, keepUsd));
    } catch (error) {
      assert.ok(error instanceof CapRefused);
      continue;
    }
    assert.ok(spent + judged.heldUsd <= 0.5 + FIT_TOLERANCE, `held past the cap at $${spent}`);
    const room = 0.5 - spent;
    const fits = requestFigures({ ...request, outputAsked: 3_072 }, "expected", T0).worstUsd + keepUsd <= room + FIT_TOLERANCE;
    if (fits) assert.ok(spent + judged.worstUsd + keepUsd <= 0.5 + FIT_TOLERANCE, `kept at $${spent}`);
  }
});

test("beforeRequestOf asks the host's keep-back for each model request, priced as the rule prices it, and applies it", async () => {
  const told = [];
  const before = beforeRequestOf({
    capUsd: () => 0.5,
    modelOf: () => SOL,
    previousOf: () => codexRequest(3).previous,
    now: () => T0,
    keepBackUsd: (request, asked) => (told.push({ turn: request.turn, asked }), reserveOf(asked)),
  });
  const { inputTokens } = codexRequest(3);
  const answer = await before({ model: "openai/gpt-6.1-sol", spentUsd: 0.03, inFlight: [], inputTokensMax: inputTokens, outputTokensAsked: 32_000, outputTokensLeast: 3_072, turn: 4, maxTurns: null, key: "k", label: "k" });
  assert.equal(told.length, 1);
  assert.equal(told[0].turn, 4);
  assert.equal(told[0].asked.inputTokens, inputTokens);
  assert.ok(told[0].asked.previous, "priced warm, from the session's previous request");
  assert.ok(answer.outputTokensMax < 32_000);
  assert.ok(0.03 + answer.holdUsd + answer.boundUsd + reserveOf(told[0].asked) <= 0.5 + FIT_TOLERANCE);
  const plain = await beforeRequestOf({ capUsd: () => 0.5, modelOf: () => SOL, previousOf: () => codexRequest(3).previous, now: () => T0, keepBackUsd: () => undefined })({ model: "gpt-6.1-sol", spentUsd: 0.03, inFlight: [], inputTokensMax: inputTokens, outputTokensAsked: 32_000, outputTokensLeast: 3_072, turn: 4, maxTurns: null, key: "k", label: "k" });
  assert.equal(plain.outputTokensMax, 32_000, "a host that keeps none back gets the rule as it was");
});
