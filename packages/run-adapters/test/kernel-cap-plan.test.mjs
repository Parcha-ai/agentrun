// A request billed to a person's subscription plan (a ChatGPT plan's) costs no dollars against the cap: it is admitted at
// $0 whatever is left, its output never limited, its wrap-up reserve $0, and no wrap-up note is put on it. A model with no
// price that is no plan's is still refused for good under a cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNNER_RECORDS, sessionSpendOf } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { CapRefused, DECISION_SESSION, noteFor, requestFigures, runCap } from "../dist/kernel/cap/index.js";
import { capOn, modelRequest, SONNET, toolRequest, UNPRICED } from "./kernel-cap-support.mjs";

/** A plan model as the server's route gives it: no price, no output ceiling known, billed to the plan. */
const PLAN = Object.freeze({ id: "gpt-6.1-sol", api: "openai-responses", price: null, outputCeiling: null, plan: true });

test("a plan request is admitted at $0 with no output limit, under any cap and at any known spend, the cap's own edge included", async () => {
  for (const [capUsd, spentUsd] of [[0.5, 0], [0.01, 0.0099], [0.5, 0.5]]) {
    const { cap } = capOn(capUsd, { spentUsd });
    const admitted = await cap.admit(modelRequest(PLAN, 400_000, 128_000));
    assert.equal(admitted.heldUsd, 0, `cap ${capUsd}, spent ${spentUsd}`);
    assert.equal(admitted.outputTokensMax, undefined, "never limited on dollars");
  }
});

test("beside plan requests, a paid tool still counts and is refused once it no longer fits", async () => {
  const { cap } = capOn(0.0025);
  for (let i = 0; i < 3; i += 1) await cap.admit(modelRequest(PLAN, 20_000, 32_000));
  const first = toolRequest("web_search", 0.001);
  await cap.admit(first);
  await cap.settle(first.id, { end: "answered", usd: 0.001 });
  const second = toolRequest("web_search", 0.001);
  await cap.admit(second);
  await cap.settle(second.id, { end: "answered", usd: 0.001 });
  await assert.rejects(cap.admit(toolRequest("web_search", 0.001)), (error) => error instanceof CapRefused && !error.forGood);
  assert.equal((await cap.admit(modelRequest(PLAN, 20_000, 32_000))).heldUsd, 0, "a plan request still goes at the cap");
});

test("the wrap-up reserve reads a plan request at $0 and puts no note on one", () => {
  assert.deepEqual(requestFigures(modelRequest(PLAN, 400_000, 128_000)), { leastUsd: 0, step0Usd: 0 });
  assert.equal(noteFor(modelRequest(PLAN, 400_000, 128_000), { told: false, capUsd: 0.5, spentUsd: 0.49, heldUsd: 0, costs: [0.1, 0.1] }), undefined);
  assert.ok(noteFor(modelRequest(SONNET, 100_000, 64_000), { told: false, capUsd: 0.5, spentUsd: 0.49, heldUsd: 0, costs: [0.1, 0.1] }), "a priced one at the same spend is noted");
});

// A run on a plan whose cap's model reader answers the run's model for any request it has no route for (a CLI session's
// one model). A decision with no cap is priced by no model of its own, so that reader answers the plan's: it must still
// be no plan request. Its provider charged it, and the plan pays for none of it.
test("a decision on a plan run with no cap is never marked the plan's: what its provider charged stays its cost", async () => {
  const store = memorySessionStore();
  const decisions = await runCap({ sessions: store, capUsd: () => undefined, modelOf: () => PLAN }).decisions(await store.open(DECISION_SESSION));
  const DECIDER = { id: "openai/gpt-6.1-sol", api: "openrouter", price: { input: 1.25, output: 10 }, outputCeiling: 4_096 };
  await decisions.admit({ kind: "decision", id: "d1", model: DECIDER, inputTokens: 100 });
  await decisions.settle("d1", { usd: 0.01 });
  const records = await store.read(DECISION_SESSION);
  const request = records.find((one) => one.kind === RUNNER_RECORDS.request)?.data;
  const turn = records.find((one) => one.kind === RUNNER_RECORDS.turn)?.data;
  assert.deepEqual([request?.plan, turn?.billing], [undefined, undefined], `no plan mark on its records: ${JSON.stringify([request, turn])}`);
  assert.deepEqual(sessionSpendOf(records).cost, { usd: 0.01, soFarUsd: 0.01, unpriced: 0 }, "its cost is what its provider charged");
});

test("an unpriced model that is no plan's is refused for good under a cap", async () => {
  const { cap } = capOn(0.5);
  await assert.rejects(cap.admit(modelRequest(UNPRICED, 1_000, 1_000)), (error) => error instanceof CapRefused && error.forGood);
});
