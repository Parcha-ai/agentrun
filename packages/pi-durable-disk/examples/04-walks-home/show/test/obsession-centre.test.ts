import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAMPED_HOLD_MS, centrePane } from "../obsession/centre.ts";
import { parseObsessionTrain } from "../obsession/train.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const training = parseObsessionTrain(lines({ event: "gen.start", prompts: 300 }, { event: "gen", i: 64, of: 300, kept: 40, rejected: {} }));
const stopped = parseObsessionTrain(lines({ event: "gen.start", prompts: 300 }, { event: "error", message: "the big model kept making things up about a real person, so the agent stopped before teaching the small model", gate: "false_claims" }));

test("while the agent is away the search is on screen until the clamped answer has had its time, then the training panel", () => {
  assert.equal(centrePane({ away: true, train: parseObsessionTrain(""), clampedAt: null, now: 0 }), "find");
  assert.equal(centrePane({ away: true, train: training, clampedAt: 1000, now: 1000 + CLAMPED_HOLD_MS - 1 }), "find", "inside the hold");
  assert.equal(centrePane({ away: true, train: training, clampedAt: 1000, now: 1000 + CLAMPED_HOLD_MS }), "train", "after it");
  assert.equal(centrePane({ away: true, train: training, clampedAt: null, now: 5 }), "train", "no big moment to hold for");
  assert.equal(centrePane({ away: false, train: training, clampedAt: null, now: 0 }), "none", "at home neither");
});

// Greptile on #129: after a gate stop the generation step had started, so the hold ran out and the training panel took over, showing training for a model that was never
// taught, and the reason was gone. The search and its stop line stay on screen.
test("after the real-person gate stopped the teach step, the search and its stop line stay on screen, long after the hold", () => {
  for (const now of [0, CLAMPED_HOLD_MS - 1, CLAMPED_HOLD_MS, CLAMPED_HOLD_MS * 10]) {
    assert.equal(centrePane({ away: true, train: stopped, clampedAt: 0, now }), "find", `at ${now}`);
  }
  assert.equal(centrePane({ away: true, train: stopped, clampedAt: null, now: 99_999 }), "find", "even with no clamped answer to hold for");
  assert.equal(centrePane({ away: false, train: stopped, clampedAt: 0, now: 99_999 }), "find", "the agent comes home and the stop is still what is on screen: there is no model to show");
});
