// The wrap-up's rule (cap.ts): when what is left of a run's cap (cap - spent - held, as admission counts it) is under
// WRAP_UP_FACTOR times a priced request's typical cost, the run's model is told once per cap: "About $X left of this
// run's budget: finish now with your answer." The typical cost is the median of the run's own model's priced requests
// after the first (the first writes the cache and costs several warm ones), else that one, else the next request's
// expected cost. One rule both paths call (pi's guard and another harness's).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cap from "../dist/cap.js";

/** `name` of cap.js called with `args`, or undefined while it has no such export (a red names the figure, not a throw). */
const call = (name, ...args) => (typeof cap[name] === "function" ? cap[name](...args) : undefined);
const close = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-12;

test("the typical cost: the next request's expected cost with none priced, the one with one, the median of those after the first with more; an unknown or $0 cost is no priced request", () => {
  assert.ok(close(call("typicalCost", [], 0.04), 0.04), "none priced: the next request's expected cost");
  assert.ok(close(call("typicalCost", [0.2], 0.04), 0.2), "one priced: that one");
  assert.ok(close(call("typicalCost", [0.2, 0.02, 0.03, 0.02], 0.04), 0.02), "the median of 0.02, 0.03, 0.02: the first (a cache write) left out");
  assert.ok(close(call("typicalCost", [0.2, 0.02, 0.04], 0.04), 0.03), "an even count: the middle two's mean");
  assert.ok(close(call("typicalCost", [0.2, null, 0, Number.NaN, 0.03], 0.04), 0.03), "unknown and $0 costs left out");
});

test("the wrap-up is due when what is left is under three times the typical cost, and not at or above it; the same under strict", () => {
  assert.equal(cap.WRAP_UP_FACTOR, 3);
  const due = call("wrapUpDue", 0.5, 0.4, 0.026, 0.025);
  assert.ok(close(due?.leftUsd, 0.074), `left $0.074 under 3 x $0.025: due ${JSON.stringify(due)}`);
  assert.equal(call("wrapUpDue", 0.5, 0.4, 0.024, 0.025), undefined, "left $0.076: not yet");
  // A $0.10 cap whose first request is expected at $0.04: due at its first request (left $0.10 < $0.12).
  assert.ok(close(call("wrapUpDue", 0.1, 0, 0, call("typicalCost", [], 0.04))?.leftUsd, 0.1), "a small cap: from the first request");
});

test("the wrap-up's words, the amount to the cent", () => {
  assert.equal(call("wrapUpWords", 0.0712), "About $0.07 left of this run's budget: finish now with your answer.");
  assert.equal(call("wrapUpWords", 0.2), "About $0.20 left of this run's budget: finish now with your answer.");
});

test("the typical cost after a restart is the one the live process counted: a request's own reported cost above 0, never a lost or stopped request's booked or held figure", async () => {
  const { ownCosts } = await import("../dist/harness-app.js");
  // As the runner writes them (runner.ts): an answered request, one lost after its response began (booked at its hold,
  // its own cost unknown), one stopped part way (counted at what streamed, its own cost unknown), a side call, a cut.
  const records = [
    { kind: "runner.request", data: { turn: 1, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 1, usd: 0.02, bookedUsd: 0.02, rule: "answered" } },
    { kind: "runner.request", data: { turn: 2, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 2, usd: null, bookedUsd: 0.5, rule: "lost" } },
    { kind: "runner.request", data: { turn: 3, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 3, usd: null, heldUsd: 0.07, stopped: true } },
    { kind: "runner.request", data: { turn: 4, model: "small", side: true } },
    { kind: "runner.turn", data: { turn: 4, usd: 0.001 } },
    { kind: "runner.request", data: { turn: 5, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 5, usd: null, cut: true } },
    { kind: "runner.request", data: { turn: 6, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 6, usd: 0.03, bookedUsd: 0.03, rule: "answered" } },
  ];
  // Live (harness-app.ts, request_end): each of the session's own requests whose usage.usd, its reported cost, is above 0.
  assert.deepEqual(ownCosts(records), [0.02, 0.03], "the costs the live process pushed, in order");
  assert.equal(call("typicalCost", ownCosts(records), 1), 0.03, "and the same typical cost");
});
