// A pi run's spec (adapterRunSpecFromLaunch) hands the adapter loop the run's one cap as its launch sets it
// (AdapterRunSpec.runCap): a launch with no maxCostUsd runs uncapped, its requests never refused by a cap it does not
// have, and no park rule; a launch with one is held to it. A CLI run's spec is pinned the same way end to end by
// runner-cli-spec.test.mjs (its runs launch with no cap and reach their answer).
import assert from "node:assert/strict";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { specFor } from "./runner-spec-support.mjs";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");

/** A model request of the run's model (the stub route's), as the loop asks the run's one cap before it leaves. */
const ask = { key: "root", label: "root", model: "faux-1", turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], inputTokensMax: 1_000, outputTokensAsked: 1_000, outputTokensLeast: 1_000 };

test("a launch with no maxCostUsd hands the loop an uncapped run: no cap figure, no park rule, and its requests are admitted", async (t) => {
  const { spec } = await specFor(t);
  assert.equal(spec.runCap.capUsd(), undefined, "no cap figure");
  assert.equal(spec.cap, undefined, "no park rule");
  const answer = await cap.runCap({ sessions: memorySessionStore(), ...spec.runCap }).before(ask);
  assert.ok(!answer || !("refuse" in answer), `admitted, never refused by a cap it does not have: ${JSON.stringify(answer)}`);
});

test("a launch with a maxCostUsd hands the loop that cap: the same request is held to it", async (t) => {
  const { spec } = await specFor(t, { launch: { maxCostUsd: 0.5 } });
  assert.equal(spec.runCap.capUsd(), 0.5, "the launch's cap");
  assert.equal(spec.cap?.capUsd, 0.5, "and its park rule at that cap");
  const answer = await cap.runCap({ sessions: memorySessionStore(), ...spec.runCap }).before(ask);
  // The stub route's model has no catalog price: under a cap its request cannot be priced, so it is refused.
  assert.ok(answer && "refuse" in answer, `held to the cap: ${JSON.stringify(answer)}`);
});
