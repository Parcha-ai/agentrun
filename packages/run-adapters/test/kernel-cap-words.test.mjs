// The kernel cap's words, as a person who has never seen a model request reads them: what the run spent (and holds for
// steps still running) of its cap, what the next step needs at the least, and the cap to raise to, to continue. The raise
// a refusal names is a cent at least, above the cap past a float's tail, and admits what was refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapRefused, leastMoney, raiseFigure, raiseTo, suggestedRaise } from "../dist/kernel/cap/index.js";
import { capOn, modelRequest, SONNET, toolRequest } from "./kernel-cap-support.mjs";

// Output at $100 a million, input free: 3,072 tokens, a request's least, are $0.3072.
const LUNA = Object.freeze({ id: "gpt-6-luna", api: "openai-responses", price: { input: 0, output: 100 }, outputCeiling: 64_000 });
const refusalOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CapRefused, String(error));
    return error;
  }
  assert.fail("not refused");
};

test("after spending: spent of the cap, what the next step needs, the cap to raise to", async () => {
  const { cap } = capOn(0.3, { spentUsd: 0.25 });
  const refusal = await refusalOf(cap.admit(modelRequest(LUNA, 0, 4_096, { outputTokensLeast: 3_072 })));
  assert.equal(refusal.message, "spend_cap_reached (out of budget): Not sent: this run has spent $0.25 of its $0.30 cap, and the next step needs at least $0.31. Raise the cap to at least $0.56 to continue.");
});

test("a paid tool's refusal: the next step is the tool, what it could cost and why", async () => {
  const { cap } = capOn(0.5, { spentUsd: 0.21 });
  const refusal = await refusalOf(cap.admit(toolRequest("monid_run", 1, { basis: "the allowance" })));
  assert.equal(refusal.message, "spend_cap_reached: Not sent: this run has spent $0.21 of its $0.50 cap, and the next step, monid_run, could cost up to $1 (the allowance). Raise the cap to at least $1.21 to continue.");
});

test("after a fraction of a cent: spent in cents, next step at least $0.05, raise at least $0.08", async () => {
  const { cap } = capOn(0.05, { spentUsd: 0.0237416 });
  const refusal = await refusalOf(cap.admit(modelRequest(LUNA, 0, 4_096, { outputTokensLeast: 500 })));
  assert.equal(refusal.message, "spend_cap_reached (out of budget): Not sent: this run has spent $0.02 of its $0.05 cap, and the next step needs at least $0.05. Raise the cap to at least $0.08 to continue.");
  assert.equal(refusal.figures.spentUsd, 0.0237416, "the figures beside the words keep it whole");
});

test("a paid tool's refusal after a fraction of a cent reads spent in cents", async () => {
  const { cap } = capOn(0.05, { spentUsd: 0.0237416 });
  const refusal = await refusalOf(cap.admit(toolRequest("monid_run", 0.05, { basis: "the allowance" })));
  assert.equal(refusal.message, "spend_cap_reached: Not sent: this run has spent $0.02 of its $0.05 cap, and the next step, monid_run, could cost up to $0.05 (the allowance). Raise the cap to at least $0.08 to continue.");
});

test("a paid call refused beside a request in flight names what is held apart from spent, with the cap that would run it", async () => {
  const { cap } = capOn(0.5, { mode: "strict", spentUsd: 0.1 });
  await cap.admit(modelRequest(LUNA, 0, 2_000));
  const refusal = await refusalOf(cap.admit(toolRequest("monid_run", 0.25, { basis: "its quote" })));
  assert.equal(refusal.message, "spend_cap_reached: Not sent: this run has spent $0.10 and holds $0.20 for steps still running, of its $0.50 cap, and the next step, monid_run, could cost up to $0.25 (its quote). Raise the cap to at least $0.55 to continue.");
});

test("a paid call refused for an unknown spend says the cap in the same format", async () => {
  const { cap } = capOn(0.5, { spentUsd: null });
  const refusal = await refusalOf(cap.admit(toolRequest("monid_run", 0.01)));
  assert.equal(refusal.message, "spend_cap_reached: Not sent: what the run has spent is unknown, so its cap of $0.50 cannot be kept: the run is out of budget.");
  assert.equal(refusal.forGood, true);
});

test("a paid call's refusal names a cap a cent above at the least, past a whole-cent cap by a hair included", async () => {
  const { cap } = capOn(0.3, { spentUsd: 0.3 + 1e-11 });
  const refusal = await refusalOf(cap.admit(toolRequest("monid_run", 0)));
  assert.equal(refusal.figures.leastCapUsd, 0.31);
});

test("an unpriced model's refusal says so in its words", async () => {
  const refusal = await refusalOf(capOn(1).cap.admit(modelRequest({ id: "mystery", api: "x", price: null, outputCeiling: 100 }, 10)));
  assert.equal(refusal.message, "spend_cap_reached: Not sent: the next model request's model has no price here, so the run's cap of $1 cannot be kept: the run is out of budget.");
});

test("raiseTo names the cent above a total a hair past a whole cent: raiseTo(0.30, 0.31 + 5e-12) is $0.32", () => {
  assert.equal(raiseTo(0.3, 0.31 + 5e-12), "$0.32");
  assert.equal(raiseTo(0.3, 0.31 + 5e-13), "$0.31", "a float's own tail is its plain cent");
});

test("a request's least rounds up to the cent within the same tail", () => {
  assert.equal(leastMoney(0.1024), "$0.11");
  assert.equal(leastMoney(0.11 + 5e-12), "$0.12");
  assert.equal(leastMoney(0.11 + 5e-13), "$0.11");
});

test("the raise a model request's refusal names admits that request", async () => {
  const refusal = await refusalOf(capOn(0.3, { spentUsd: 0.25 }).cap.admit(modelRequest(LUNA, 0, 4_096, { outputTokensLeast: 3_072 })));
  await capOn(refusal.figures.leastCapUsd, { spentUsd: 0.25 }).cap.admit(modelRequest(LUNA, 0, 4_096, { outputTokensLeast: 3_072 }));
});

test("the raise a paid call's refusal names admits that call", async () => {
  const refusal = await refusalOf(capOn(0.5, { spentUsd: 0.21 }).cap.admit(toolRequest("monid_run", 1)));
  await capOn(refusal.figures.leastCapUsd, { spentUsd: 0.21 }).cap.admit(toolRequest("monid_run", 1));
});

test("a request past the cap names a raise a cent above it, never the cap itself", () => {
  assert.equal(raiseFigure(0.3, 0.3), 0.31);
  assert.equal(raiseFigure(0.3, 0.2), 0.31);
});

test("the raise a refusal names is above the cap by more than a float's tail, a cap a hair under a cent included", () => {
  assert.ok(raiseFigure(0.3, 0.3) > 0.3 + 1e-9);
  assert.ok(raiseFigure(0.31 - 1e-12, 0.31) > 0.31 - 1e-12 + 1e-9);
});

test("least_cap_usd under each mode admits the refused request at it, and a cent under refuses it", async () => {
  const previous = { model: SONNET.id, cachedTokens: 90_000, inputTokens: 10_000, boundTokens: 100_000, endedAt: Date.parse("2026-11-08T06:00:00Z") - 1_000 };
  for (const mode of ["expected", "strict"]) {
    const ask = () => modelRequest(SONNET, 100_000, 4_096, { previous });
    const refusal = await refusalOf(capOn(0.01, { mode }).cap.admit(ask()));
    await capOn(refusal.figures.leastCapUsd, { mode }).cap.admit(ask());
    await assert.rejects(capOn(refusal.figures.leastCapUsd - 0.01, { mode }).cap.admit(ask()), CapRefused, mode);
  }
});

test("the suggested raise is spent + 10x least, a whole dollar above the cap; a float just past a dollar stays that dollar", () => {
  assert.equal(suggestedRaise(0.5, 0.48, 0.1024), 2);
  assert.equal(suggestedRaise(5, 0.2, 0.01), 6, "above the cap, the next dollar above it");
  assert.equal(suggestedRaise(1, 2.0000000000000004, 0.1), 3);
  assert.ok(suggestedRaise(2, 1.5, 0.05) > 2 + 1e-9, "a raise past a float's tail");
});
