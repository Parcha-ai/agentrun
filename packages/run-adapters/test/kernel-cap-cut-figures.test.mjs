// A request the cap sends with less output than it asks (its output limited to what is left) is admitted with what its
// harness says if the provider cuts its answer at that limit: the run's cap, and the least cap that sends the request at
// all it asked, so a cut final answer ends the run naming both. The hold stays the request's worst case at the output it
// is sent with: the cap is never passed, whatever the answer does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beforeRequestOf, pricingOf, raiseFigure } from "../dist/kernel/cap/index.js";

/** GPT-6.1 Sol as the catalog prices it: $2 in, $10 out, $0.10 a cache read, $2.50 a cache write; 128,000 out. */
const SOL = Object.freeze({ id: "gpt-6.1-sol", api: "openai-responses", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 128_000, reasoning: true });
const judge = (capUsd, request, keepBackUsd) => beforeRequestOf({ capUsd: () => capUsd, modelOf: () => SOL, ...(keepBackUsd === undefined ? {} : { keepBackUsd: () => keepBackUsd }) })({ model: SOL.id, key: "s", label: "s", turn: 6, maxTurns: null, inFlight: [], ...request });
const worst = (input, output) => pricingOf(SOL.price)(input, output);

test("a request sent with less output than it asks carries the cap and the least cap that sends it whole", async () => {
  // The walk's sixth request: $0.169 spent of $0.50, 60,000 tokens in, 128,000 out asked, 2,224 needed.
  const asked = { inputTokensMax: 60_000, outputTokensAsked: 128_000, outputTokensLeast: 2_224, spentUsd: 0.169 };
  const verdict = await judge(0.5, asked);
  assert.ok("holdUsd" in verdict, JSON.stringify(verdict));
  assert.ok(verdict.outputTokensMax < 128_000, `limited: ${verdict.outputTokensMax}`);
  assert.deepEqual(verdict.capCut, { capUsd: 0.5, raiseToUsd: raiseFigure(0.5, 0.169 + worst(60_000, 128_000)) }, "the cap a cut would be said against, and the cap that sends it whole");
});

test("a request sent with all it asks carries no cut figures: no cut of its answer is the cap's", async () => {
  const verdict = await judge(5, { inputTokensMax: 60_000, outputTokensAsked: 32_000, outputTokensLeast: 2_224, spentUsd: 0.169 });
  assert.equal(verdict.outputTokensMax, 32_000);
  assert.equal(verdict.capCut, undefined);
});

test("the hold is the worst case at the output the request is sent with, whatever least it was admitted at", async () => {
  for (const least of [1_024, 2_224, 9_216]) {
    const verdict = await judge(0.5, { inputTokensMax: 60_000, outputTokensAsked: 128_000, outputTokensLeast: least, spentUsd: 0.169 });
    assert.ok(Math.abs(verdict.holdUsd - worst(60_000, verdict.outputTokensMax)) < 1e-12, `least ${least}: held ${verdict.holdUsd}, worst case ${worst(60_000, verdict.outputTokensMax)}`);
    assert.ok(0.169 + verdict.holdUsd <= 0.5 + 1e-12, `never past the cap: ${0.169 + verdict.holdUsd}`);
  }
});

test("with a keep-back (serve's wrap-up reserve), the cap a cut names sends the request whole beside it", async () => {
  // The walk's sixth request beside a $0.05 reserve: its least and the reserve fit $0.50, so it is clamped to keep the
  // reserve free. The cap the cut names must leave room for the reserve too: at that cap, the same request with the same
  // reserve is sent with all it asks, the reserve still free.
  const asked = { inputTokensMax: 60_000, outputTokensAsked: 128_000, outputTokensLeast: 2_224, spentUsd: 0.169 };
  const keepUsd = 0.05;
  const cut = await judge(0.5, asked, keepUsd);
  assert.ok(cut.outputTokensMax < 128_000 && cut.capCut, JSON.stringify(cut));
  const raised = await judge(cut.capCut.raiseToUsd, asked, keepUsd);
  assert.equal(raised.outputTokensMax, 128_000, `at the named $${cut.capCut.raiseToUsd}, sent whole: ${raised.outputTokensMax}`);
  assert.equal(raised.capCut, undefined, "no cut of its answer is the cap's at the named cap");
  assert.ok(0.169 + raised.holdUsd + keepUsd <= cut.capCut.raiseToUsd, `the reserve still free: ${0.169 + raised.holdUsd + keepUsd}`);
});

test("without a keep-back, the cap a cut names sends the same request whole", async () => {
  const asked = { inputTokensMax: 60_000, outputTokensAsked: 128_000, outputTokensLeast: 2_224, spentUsd: 0.169 };
  const cut = await judge(0.5, asked);
  const raised = await judge(cut.capCut.raiseToUsd, asked);
  assert.equal(raised.outputTokensMax, 128_000);
  assert.equal(raised.capCut, undefined);
});
