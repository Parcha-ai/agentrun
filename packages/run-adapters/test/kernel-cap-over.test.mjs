// How a run ends once its booked spend passed its cap (overCapOf): read as the cap reads its model session, each request
// at the figure the cap counts it at. A request cut by a crash counts at its hold, its worst case, which the cap let go
// only within the cap. An answer booked past the cap ends the run spend_cap_reached in its words: every request is held
// at its worst case, a cache miss included, so nothing excuses a spend past the cap (a bound an old record still carries
// is not read).
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import * as cap from "../dist/kernel/cap/index.js";

const request = (turn, data = {}) => ({ kind: RUNNER_RECORDS.request, data: { turn, model: "m", ...data } });
const turn = (turn, data) => ({ kind: RUNNER_RECORDS.turn, data: { turn, ...data } });

test("a request cut by a crash counts at its hold, never past the cap it was admitted under: no end, the run pauses at its next request", () => {
  // $0.01 spent, then a request held at $0.25, cut by a crash (booked cut, its cost unknown): $0.26 of $0.50. A bound an
  // old record carries beside its hold ($0.50 here) is not read.
  const records = [request(1, { heldUsd: 0.01 }), turn(1, { usd: 0.01, bookedUsd: 0.01, rule: "answered" }), request(2, { heldUsd: 0.25, boundUsd: 0.5 }), turn(2, { usd: null, cut: true })];
  assert.equal(cap.overCapOf(records, 0, 0.5), undefined);
});

test("an answer that passed the cap ends the run in the cap's words: the crossing answer booked", () => {
  const records = [request(1, { heldUsd: 0.4 }), turn(1, { usd: 0.7, bookedUsd: 0.7, rule: "answered" })];
  assert.equal(cap.overCapOf(records, 0, 0.5), "spend_cap_reached: The run cost $0.70, $0.20 over its cap of $0.50.");
  // What its other sessions spent counts too.
  assert.equal(cap.overCapOf([request(1, { heldUsd: 0.1 }), turn(1, { usd: 0.3, bookedUsd: 0.3, rule: "answered" })], 0.3, 0.5), "spend_cap_reached: The run cost $0.60, $0.10 over its cap of $0.50.");
});

test("an answer booked past the cap ends the run, whatever bound an old record carries beside its hold", () => {
  // Held at $0.40, an old record's $0.20 bound beside it: booked $0.55, $0.05 over a $0.50 cap, ends the run.
  assert.equal(cap.overCapOf([request(1, { heldUsd: 0.4, boundUsd: 0.2 }), turn(1, { usd: 0.55, bookedUsd: 0.55, rule: "answered" })], 0, 0.5), "spend_cap_reached: The run cost $0.55, $0.05 over its cap of $0.50.");
  assert.match(cap.overCapOf([request(1, { heldUsd: 0.4, boundUsd: 0.2 }), turn(1, { usd: 0.8, bookedUsd: 0.8, rule: "answered" })], 0, 0.5) ?? "", /^spend_cap_reached: The run cost \$0\.80/);
});

test("within the cap, with no cap's figure unknown, nothing ends", () => {
  assert.equal(cap.overCapOf([request(1, { heldUsd: 0.1 }), turn(1, { usd: 0.1, bookedUsd: 0.1, rule: "answered" })], 0, 0.5), undefined);
  // A spend unknown (a cut request with no hold) reads no end: the cap's own rule refuses the next request for good.
  assert.equal(cap.overCapOf([request(1), turn(1, { usd: null, cut: true })], 0, 0.5), undefined);
});
