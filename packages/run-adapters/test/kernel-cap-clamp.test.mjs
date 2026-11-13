// A request is limited to the output what is left of the cap buys, never more than it asks, and held at that limit, so
// output never passes the cap; it is refused unsent only when what is left cannot buy its least (1,024 tokens for the
// answer, 2,048 when it thinks on an API whose thinking takes a budget, or the least its body says it needs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapRefused } from "../dist/kernel/cap/index.js";
import { capOn, modelRequest, SONNET, usd } from "./kernel-cap-support.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ""} ${actual} vs ${expected}`);

test("below a request's worst case, it is sent with the output what is left buys, and held at that", async () => {
  // $0.10 less 10,000 tokens in ($0.0375) buys 4,166 tokens at $15 a million.
  const { cap } = capOn(0.1, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 64_000));
  assert.equal(admitted.outputTokensMax, 4_166);
  near(admitted.heldUsd, usd(10_000, 3.75) + usd(4_166, 15));
});

test("the clamp never raises a request: one asking for less keeps its own, held at it", async () => {
  const { cap } = capOn(0.1, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 2_000));
  assert.equal(admitted.outputTokensMax, 2_000);
  near(admitted.heldUsd, usd(10_000, 3.75) + usd(2_000, 15));
});

test("a cap that cannot buy 1,024 answer tokens refuses unsent, naming the least cap that would", async () => {
  // Its least is $0.05286: a $0.05 cap refuses it, and names $0.06.
  const { cap } = capOn(0.05, { mode: "strict" });
  await assert.rejects(cap.admit(modelRequest(SONNET, 10_000, 4_096)), (error) => error instanceof CapRefused && !error.forGood && error.figures.leastCapUsd === 0.06 && /Raise the cap to at least \$0\.06 to continue\./.test(error.message));
});

test("what is left is the cap less spent and held: beside one holding the rest a request is refused; after it answers the next gets what is then left", async () => {
  const { cap } = capOn(0.2, { mode: "strict" });
  const first = modelRequest(SONNET, 10_000, 64_000);
  const admitted = await cap.admit(first);
  assert.ok(admitted.heldUsd <= 0.2 && admitted.heldUsd > 0.2 - usd(1, 15), `it holds all that is left, to the token: ${admitted.heldUsd}`);
  await assert.rejects(cap.admit(modelRequest(SONNET, 10_000, 64_000)), CapRefused);
  await cap.settle(first.id, { end: "answered", usd: 0.05 });
  const next = await cap.admit(modelRequest(SONNET, 10_000, 64_000));
  assert.equal(next.outputTokensMax, Math.floor((0.15 - usd(10_000, 3.75)) / usd(1, 15) + 1e-9));
});

test("spent down under 1,024 tokens' worth: refused saying what was spent and what the next request needs", async () => {
  const { cap } = capOn(0.1, { mode: "strict", spentUsd: 0.09 });
  await assert.rejects(cap.admit(modelRequest(SONNET, 10_000, 4_096)), (error) => error instanceof CapRefused && /this run has spent \$0\.09 of its \$0\.10 cap, and the next step needs at least \$0\.06\./.test(error.message));
});

test("with thinking, max_tokens is what is left buys and the thinking budget fits under it with 1,024 for the answer", async () => {
  const { cap } = capOn(0.1, { mode: "strict" });
  const admitted = await cap.admit(modelRequest(SONNET, 10_000, 4_096, { thinkingBudget: 8_000 }));
  assert.equal(admitted.outputTokensMax, 4_166);
  assert.equal(admitted.thinkingBudget, 4_166 - 1_024);
});

test("the least is 1,024 tokens without thinking and 2,048 with it", () => {
  const { cap } = capOn(10, { mode: "strict" });
  near(cap.leastUsd(modelRequest(SONNET, 10_000, 4_096)), usd(10_000, 3.75) + usd(1_024, 15));
  near(cap.leastUsd(modelRequest(SONNET, 10_000, 4_096, { thinkingBudget: 8_000 })), usd(10_000, 3.75) + usd(2_048, 15));
  near(cap.leastUsd(modelRequest(SONNET, 10_000, 4_096, { outputTokensLeast: 3_072 })), usd(10_000, 3.75) + usd(3_072, 15), "or what the body says it needs");
});
