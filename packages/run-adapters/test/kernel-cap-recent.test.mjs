// A Codex run at a $0.50 cap, replayed on the kernel cap from its journal: four requests of gpt-6.1-sol ($2 in, $10 out,
// $0.10 a cache read, $2.50 a cache write a million tokens), a paid call of $0.00015, then a fifth. Each figure below is
// the live run's (its runner.request holds and bounds, its runner.turn usage and cost) but the bounds, which the journal
// does not keep: each is read back from its hold and bound at the 32,000 output tokens Codex asks (the bound's bytes at
// $2.50 a million, beside $0.32 of output). Request 5 was admitted at what was left, so its bound is taken as 76,000
// bytes: between 73,924, the least that made the live note due, and request 6's 78,854.
//   - Request 4 was smaller (Codex's own request while a tool ran, none of it read from the cache). The session's
//     history reset on it, so request 5 was priced cold, held at all that was left, and told "About $0.43 left of this
//     run's budget: finish now". Kept beside the others, request 5 is priced from request 3's cache (the one it read:
//     13,088 tokens) and no note is due.
//   - Request 3 was held at its whole 32,000 tokens, its hold and bound ($0.36 and $0.12) past what the wrap-up's reserve
//     leaves, so the tool call Codex started while it streamed was refused. With the reserve kept back it is sent with
//     fewer tokens, its worst case and the reserve fit, and the call passes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capRule, FIT_TOLERANCE, noteFor, recentAfter, requestFigures, typicalCost } from "../dist/kernel/cap/index.js";
import { T0 } from "./kernel-cap-support.mjs";

const SOL = Object.freeze({ id: "gpt-6.1-sol", api: "openai-responses", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 128_000, reasoning: true });
const CAP = 0.5;
/** Requests 1 to 4 as the run booked them: each one's bound, its usage and its cost. */
const RUN = [
  { bound: 46_059, usage: { input: 3, cacheRead: 0, cacheWrite: 9_760 }, usd: 0.025116 },
  { bound: 46_883, usage: { input: 3, cacheRead: 9_760, cacheWrite: 95 }, usd: 0.0018695 },
  { bound: 62_658, usage: { input: 3, cacheRead: 9_855, cacheWrite: 3_233 }, usd: 0.016844 },
  { bound: 53_143, usage: { input: 3, cacheRead: 0, cacheWrite: 9_857 }, usd: 0.0249585 },
];
const PAID = 0.00015;
const BOUND_5 = 76_000;
const ask = (bound, recent) => ({ kind: "model", id: "next", model: SOL, inputTokens: bound, outputAsked: 32_000, outputTokensLeast: 3_072, ...(recent.length ? { recent } : {}) });
/** The session's recent requests after the first `n`, each ended a second after the one before, the last at T0 - 1 s. */
const recentAfterFirst = (n) => RUN.slice(0, n).reduce((recent, one, i) => recentAfter(recent, { model: SOL.id, cachedTokens: one.usage.cacheRead + one.usage.cacheWrite, inputTokens: one.usage.input, boundTokens: one.bound, endedAt: T0 - (n - i) * 1_000 }), []);
/** The session's recent requests as the reset left them after the first `n` (the base's previousAfter): the last one,
 *  none once a smaller one ended. */
const previousAfterFirst = (n) => {
  let previous;
  RUN.slice(0, n).forEach((one, i) => {
    const ended = { model: SOL.id, cachedTokens: one.usage.cacheRead + one.usage.cacheWrite, inputTokens: one.usage.input, boundTokens: one.bound, endedAt: T0 - (n - i) * 1_000 };
    previous = previous && ended.boundTokens < previous.boundTokens ? undefined : ended;
  });
  return previous ? [previous] : [];
};
const spentAfter = (n) => RUN.slice(0, n).reduce((sum, one) => sum + one.usd, 0);
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} vs ${expected}`);

test("the run's request 5, after a smaller request of Codex's own: priced from request 3's cache, no wrap-up; reset, it held all that was left and was told to finish", () => {
  const spentUsd = spentAfter(4) + PAID;
  const state = { capUsd: CAP, spentUsd, heldUsd: 0, mode: "expected", now: T0 };
  const recent = recentAfterFirst(4);
  assert.deepEqual(recent.map((one) => one.boundTokens), [46_059, 46_883, 62_658, 53_143], "the smaller request kept beside the others");
  const after = capRule.judge(ask(BOUND_5, recent), state);
  // Request 3's cache (its 13,088 tokens, what the live request 5 read), its 3 fresh tokens and the 13,342 bytes grown.
  near(after.heldUsd, (13_088 * 0.1 + (3 + BOUND_5 - 62_658) * 2.5 + 32_000 * 10) / 1e6, "held warm from request 3");
  assert.equal(after.outputTokensMax, 32_000);
  const before = capRule.judge(ask(BOUND_5, previousAfterFirst(4)), state);
  assert.ok(before.heldUsd > CAP - spentUsd - 1e-5 && before.heldUsd <= CAP - spentUsd, `reset, it held what was left: $${before.heldUsd}`);
  const costs = RUN.map((one) => one.usd);
  const told = (recentOnes) => noteFor(ask(BOUND_5, recentOnes), { ...state, costs, told: false })?.words;
  assert.equal(told(previousAfterFirst(4)), "About $0.43 left of this run's budget: finish now with your answer.", "the live run's note");
  assert.equal(told(recent), undefined, "no note on a $0.07 job");
  console.log(`# 01a1da86 request 5: held $${before.heldUsd.toFixed(4)} at ${before.outputTokensMax} tokens with the note before; $${after.heldUsd.toFixed(4)} at ${after.outputTokensMax}, no note, after`);
});

test("the run's request 3, its tool call made while it streamed: held at 32,000 tokens it left no room for the reserve; kept back, its worst and the reserve fit", () => {
  const spentUsd = spentAfter(2);
  const state = { capUsd: CAP, spentUsd, heldUsd: 0, mode: "expected", now: T0 };
  const request = ask(RUN[2].bound, recentAfterFirst(2));
  const figures = requestFigures(request, "expected", T0);
  const reserve = typicalCost(RUN.slice(0, 2).map((one) => one.usd), figures.step0Usd) + figures.leastUsd;
  const before = capRule.judge(request, state);
  near(before.heldUsd, 0.3604305, "the live hold");
  near(before.boundUsd, 0.1162145, "the live bound");
  assert.ok(spentUsd + before.heldUsd + before.boundUsd + reserve > CAP, "the gate counts it at hold and bound: no room for the reserve, the call refused");
  const after = capRule.judge(request, { ...state, keepUsd: reserve });
  assert.ok(after.outputTokensMax >= 3_072 && after.outputTokensMax < 32_000, `sent with fewer tokens: ${after.outputTokensMax}`);
  assert.ok(spentUsd + after.heldUsd + after.boundUsd + reserve <= CAP + FIT_TOLERANCE, "its worst and the reserve fit: the call passes");
  assert.ok(spentUsd + after.worstUsd <= CAP, "even a whole cache miss stays under the cap");
  console.log(`# 01a1da86 request 3: held $${before.heldUsd.toFixed(4)} + $${before.boundUsd.toFixed(4)} at 32000 before; $${after.heldUsd.toFixed(4)} + $${after.boundUsd.toFixed(4)} at ${after.outputTokensMax} with $${reserve.toFixed(4)} kept, after`);
});
