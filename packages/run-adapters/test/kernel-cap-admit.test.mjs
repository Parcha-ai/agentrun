// cap.admit, the one door every paid step goes through: a model request on any harness, a priced tool, a decision. It
// reads the cap before every check, so a raise holds from the next paid step; what cannot be kept within a cap (an
// unmeasured input, an unknown spend) is refused for good; an admission carries what the step is held at, its bound and
// its stopped figure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapRefused } from "../dist/kernel/cap/index.js";
import { capOn, modelRequest, SONNET, toolRequest, usd } from "./kernel-cap-support.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ""} ${actual} vs ${expected}`);

test("a tool hold that is not a number, or below 0, is refused for good, and the cap is never passed after it: under $1, NaN, then $50, then $500, all refused", async () => {
  const { cap } = capOn(1);
  await assert.rejects(cap.admit(toolRequest("fetch", Number.NaN)), (error) => error instanceof CapRefused && error.forGood);
  await assert.rejects(cap.admit(toolRequest("fetch", 50)), (error) => error instanceof CapRefused && !error.forGood);
  await assert.rejects(cap.admit(toolRequest("fetch", 500)), CapRefused);
  await assert.rejects(cap.admit(toolRequest("fetch", -5)), (error) => error instanceof CapRefused && error.forGood, "a negative hold frees no room");
  await assert.rejects(cap.admit(toolRequest("fetch", Number.POSITIVE_INFINITY)), (error) => error instanceof CapRefused && error.forGood);
  assert.equal(cap.heldUsd(), 0);
  assert.equal(cap.spentUsd(), 0, "the spend stays a number");
});

test("an unmeasured input is refused under a cap, never read as none", async () => {
  await assert.rejects(capOn(10).cap.admit(modelRequest(SONNET, undefined)), (error) => error instanceof CapRefused && error.forGood && /size of the next model request's input is unknown/.test(error.message));
  await capOn(undefined).cap.admit(modelRequest(SONNET, undefined));
});

test("an unknown spend refuses every request unsent", async () => {
  const { cap } = capOn(10, { spentUsd: null });
  await assert.rejects(cap.admit(modelRequest(SONNET, 10)), (error) => error instanceof CapRefused && error.forGood && /what the run has spent is unknown/.test(error.message));
  await assert.rejects(cap.admit(toolRequest("monid_run", 0)), CapRefused);
});

test("a spend that is not a finite figure of 0 or more (NaN, Infinity, below 0) is refused as an unknown spend, in words with no NaN", async () => {
  for (const spentUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const { cap } = capOn(1, { spentUsd });
    await assert.rejects(cap.admit(toolRequest("fetch", 0.1)), (error) => error instanceof CapRefused && error.forGood && error.message === "spend_cap_reached: Not sent: what the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.", `spent ${spentUsd}`);
    await assert.rejects(cap.admit(modelRequest(SONNET, 10)), (error) => error instanceof CapRefused && !/NaN/.test(error.message), `spent ${spentUsd}, a model request`);
  }
});

test("a refusal for good says the run's spend, never sent", async () => {
  const { cap } = capOn(10, { spentUsd: 0.25 });
  const refusal = await cap.admit(modelRequest({ ...SONNET, id: "unbounded", outputCeiling: null }, 10)).catch((error) => error);
  assert.ok(refusal instanceof CapRefused && refusal.forGood);
  assert.equal(refusal.spentUsd, 0.25);
  assert.equal(cap.heldUsd(), 0, "nothing held for a request never sent");
});

test("an admission carries the held figure, the bound and the stopped figure; strict holds the worst case with no bound", async () => {
  const previous = { model: SONNET.id, cachedTokens: 90_000, inputTokens: 10_000, boundTokens: 100_000, endedAt: Date.parse("2026-11-08T06:00:00Z") - 1_000 };
  const expected = await capOn(10).cap.admit(modelRequest(SONNET, 100_000, 1_000, { previous }));
  near(expected.heldUsd, usd(90_000, 0.3) + usd(10_000, 3.75) + usd(1_000, 15));
  near(expected.boundUsd, usd(100_000, 3.75) + usd(1_000, 15) - expected.heldUsd);
  // Stopped having streamed 10 tokens: its input, those and 1,024 more, at most its 1,000-token limit, within its hold.
  near(expected.stoppedUsd(10), Math.min(expected.heldUsd, usd(90_000, 0.3) + usd(10_000, 3.75) + usd(1_000, 15)));
  const strict = await capOn(10, { mode: "strict" }).cap.admit(modelRequest(SONNET, 100_000, 1_000, { previous }));
  near(strict.heldUsd, usd(100_000, 3.75) + usd(1_000, 15));
  assert.equal(strict.boundUsd, 0);
});

test("a least plus spent that make the cap in decimal fit it, never refused by a float's tail", async () => {
  // 0.0028 + 0.3072 is 0.31000000000000005 in a float: it is the 0.31 cap, and fits it.
  const LUNA = { id: "luna", api: "openai-responses", price: { input: 0, output: 100 }, outputCeiling: 64_000 };
  await capOn(0.31, { spentUsd: 0.0028 }).cap.admit(modelRequest(LUNA, 0, 3_072, { outputTokensLeast: 3_072 }));
});

test("a raise during work holds from the next paid check: the cap is read before each one, never clamped to the old cap", async () => {
  let capUsd = 0.2;
  const { cap } = capOn(() => capUsd, { mode: "strict" });
  const first = modelRequest(SONNET, 10_000, 16_384);
  const one = await cap.admit(first);
  assert.ok(one.outputTokensMax < 16_384, "clamped under $0.20");
  await cap.settle(first.id, { end: "answered", usd: 0.05 });
  capUsd = 10;
  const two = await cap.admit(modelRequest(SONNET, 10_000, 16_384));
  assert.equal(two.outputTokensMax, 16_384, "judged under the raised cap with its own 16,384 tokens");
  const call = await cap.admit(toolRequest("monid_run", 5));
  assert.equal(call.heldUsd, 5, "a paid call reads the raised cap too");
});
