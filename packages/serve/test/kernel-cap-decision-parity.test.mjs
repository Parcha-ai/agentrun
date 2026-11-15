// A workflow's decisions priced through the kernel cap (run-adapters kernel/cap createCap, the one place both the runner's
// workflow host and pi's decisions price them) hold what main holds for them (serve decision-cap.ts holdOf, OpenRouter's
// catalog price): each case asserts main's own figure, read from main's code on the same price and request.
// - A run with no cap prices nothing: a decision is never refused for a price its catalog could not give.
// - Its output is the model's most completion tokens (the worst case: no answer can take more), and a model with no most
//   output whose output is priced has no bound, so neither holds it.
// - Its fees (the catalog's per request and per image) are held beside its tokens, and each image reads as
//   DECISION_IMAGE_TOKENS of input.
import assert from "node:assert/strict";
import { test } from "node:test";

const kernel = await import("../../run-adapters/dist/kernel/cap/index.js");
const { holdOf } = await import("../dist/decision-cap.js");

const MODEL = "openai/gpt-6.1-sol";
const STATE = { applicant: "Ada Lovelace", country: "UK" };
const QUESTIONS = { match: "Is the applicant the person in the record?", risk: "Is the country high risk?", note: "Anything else?" };
const IMAGES = { passport: "data:image/png;base64,AAAA", selfie: "data:image/png;base64,BBBB" };

/** The catalog's price of MODEL, as OpenRouter gives it (per token, per request, per image). */
const priceOf = (overrides = {}) => ({ promptUsd: 1.25e-6, completionUsd: 10e-6, requestUsd: 0, imageUsd: 0, maxCompletionTokens: 4_096, ...overrides });

/** main's hold for the request on `price`: serve decision-cap.ts holdOf on OpenRouter's catalog. */
async function mainHoldOf(price, { images = {} } = {}) {
  const provider = { id: "openrouter", priceOf: async () => price };
  return holdOf(provider, { label: "verify", model: MODEL, state: STATE, questions: QUESTIONS, images });
}
async function mainHold(price, options) {
  const hold = await mainHoldOf(price, options);
  assert.ok("usd" in hold, `main holds it: ${JSON.stringify(hold)}`);
  return hold.usd;
}

/** The kernel's decision request for the same: its model at the catalog's rates (a million tokens), its fees beside. */
const decision = (price, { images = {}, id = "decide-1" } = {}) => ({
  kind: "decision",
  id,
  model: { id: MODEL, api: "openrouter", price: { input: price.promptUsd * 1e6, output: price.completionUsd * 1e6 }, outputCeiling: price.maxCompletionTokens },
  inputTokens: Buffer.byteLength(JSON.stringify({ state: STATE, questions: QUESTIONS }), "utf8"),
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

test("a decision on a model with no most output, its output priced, has no bound: the kernel refuses it for good, and main leaves it unpriced", async () => {
  const price = priceOf({ maxCompletionTokens: null });
  const refused = await kernel.createCap({ capUsd: () => 100 }).admit(decision(price)).catch((error) => error);
  assert.ok(refused instanceof kernel.CapRefused, `refused: ${refused}`);
  assert.equal(refused.forGood, true, "no raise sends it");
  assert.ok("unpriced" in await mainHoldOf(price), "main holds no figure for it either");
});

test("a decision is held at its model's most completion tokens, as main holds it", async () => {
  const price = priceOf({ maxCompletionTokens: 4_096 });
  const admitted = await kernel.createCap({ capUsd: () => 100 }).admit(decision(price));
  const input = Buffer.byteLength(JSON.stringify({ state: STATE, questions: QUESTIONS }), "utf8");
  near(admitted.heldUsd, input * price.promptUsd + 4_096 * price.completionUsd, "its input and its most output");
  near(admitted.heldUsd, await mainHold(price), "main's hold");
});

test("its fees go into its hold: the catalog's price per request and per image, each image read as 3,300 input tokens, as main holds it", async () => {
  const price = priceOf({ requestUsd: 0.002, imageUsd: 0.0005 });
  const admitted = await kernel.createCap({ capUsd: () => 100 }).admit(decision(price, { images: IMAGES }));
  near(admitted.heldUsd, await mainHold(price, { images: IMAGES }), "with two images and a request fee");
});
