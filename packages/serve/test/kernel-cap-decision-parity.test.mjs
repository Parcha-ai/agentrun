// A workflow's decisions priced through the kernel cap (run-adapters kernel/cap createCap, the one place both the runner's
// workflow host and pi's decisions price them) hold what main holds for them (serve decision-cap.ts holdOf, OpenRouter's
// catalog price): each case asserts main's own figure, read from main's code on the same price and request.
// - A run with no cap prices nothing: a decision is never refused for a price its catalog could not give.
// - Expected mode: its output is DECISION_OUTPUT_TOKENS (256) a question, whatever its model's most output, and a model
//   with no most output is admitted so.
// - Strict mode: its output is the model's most completion tokens.
// - Its fees (the catalog's per request and per image) are held beside its tokens, and each image reads as
//   DECISION_IMAGE_TOKENS of input.
import assert from "node:assert/strict";
import { test } from "node:test";

const kernel = await import("../../run-adapters/dist/kernel/cap/index.js");
const { holdOf } = await import("../dist/decision-cap.js");

const MODEL = "openai/gpt-6-sol";
const STATE = { applicant: "Ada Lovelace", country: "UK" };
const QUESTIONS = { match: "Is the applicant the person in the record?", risk: "Is the country high risk?", note: "Anything else?" };
const IMAGES = { passport: "data:image/png;base64,AAAA", selfie: "data:image/png;base64,BBBB" };

/** The catalog's price of MODEL, as OpenRouter gives it (per token, per request, per image). */
const priceOf = (overrides = {}) => ({ promptUsd: 1.25e-6, completionUsd: 10e-6, requestUsd: 0, imageUsd: 0, maxCompletionTokens: 4_096, ...overrides });

/** main's hold for the request on `price`, under `mode`: serve decision-cap.ts holdOf on OpenRouter's catalog. */
async function mainHold(price, mode, { images = {} } = {}) {
  const provider = { id: "openrouter", priceOf: async () => price };
  const hold = await holdOf(provider, { label: "verify", model: MODEL, state: STATE, questions: QUESTIONS, images }, mode);
  assert.ok("usd" in hold, `main holds it: ${JSON.stringify(hold)}`);
  return hold.usd;
}

/** The kernel's decision request for the same: its model at the catalog's rates (a million tokens), its fees beside. */
const decision = (price, { images = {}, id = "decide-1" } = {}) => ({
  kind: "decision",
  id,
  model: { id: MODEL, api: "openrouter", price: { input: price.promptUsd * 1e6, output: price.completionUsd * 1e6 }, outputCeiling: price.maxCompletionTokens },
  inputTokens: Buffer.byteLength(JSON.stringify({ state: STATE, questions: QUESTIONS }), "utf8"),
  questions: Object.keys(QUESTIONS).length,
  images: Object.keys(images).length,
  requestUsd: price.requestUsd,
  imageUsd: price.imageUsd,
});

const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-12, `${what}: the kernel holds ${actual}, main ${expected}`);

test("a run with no cap prices no decision: one whose catalog price could not be read is let go, never refused for it", async () => {
  const cap = kernel.createCap({ capUsd: () => undefined });
  const admitted = await cap.admit({ ...decision(priceOf()), model: "unreadable" }).catch((error) => error);
  assert.equal(admitted instanceof Error, false, `let go, as main lets an uncapped decision go unpriced: ${admitted}`);
  assert.equal(admitted.heldUsd, 0, "nothing held");
});

test("expected mode: a decision on a model with no most output is held at 256 output tokens a question, as main holds it", async () => {
  const price = priceOf({ maxCompletionTokens: null });
  const cap = kernel.createCap({ capUsd: () => 100, mode: "expected" });
  const admitted = await cap.admit(decision(price)).catch((error) => error);
  assert.equal(admitted instanceof Error, false, `admitted: ${admitted}`);
  near(admitted.heldUsd, await mainHold(price, "expected"), "expected, no most output");
});

test("strict mode holds the model's most completion tokens, and expected mode 256 a question, each as main holds it", async () => {
  const price = priceOf({ maxCompletionTokens: 4_096 });
  const strict = await kernel.createCap({ capUsd: () => 100, mode: "strict" }).admit(decision(price));
  near(strict.heldUsd, await mainHold(price, "strict"), "strict");
  const expected = await kernel.createCap({ capUsd: () => 100, mode: "expected" }).admit(decision(price));
  near(expected.heldUsd, await mainHold(price, "expected"), "expected");
});

test("its fees go into its hold: the catalog's price per request and per image, each image read as 3,300 input tokens, as main holds it", async () => {
  const price = priceOf({ requestUsd: 0.002, imageUsd: 0.0005 });
  const admitted = await kernel.createCap({ capUsd: () => 100, mode: "strict" }).admit(decision(price, { images: IMAGES }));
  near(admitted.heldUsd, await mainHold(price, "strict", { images: IMAGES }), "with two images and a request fee");
});
