// How a run ends once its booked spend passed its cap (overCapOf): read as the cap reads its model session, each request
// at the figure the cap counts it at. A request cut by a crash counts at its hold plus its bound, and that bound is kept:
// its cost is unknown, and it may have missed the cache, so a run over its cap by no more than such a bound pauses for a
// raise, never fails. An answer that passed the cap with no such bound ends the run spend_cap_reached in its words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import * as cap from "../dist/kernel/cap/index.js";

const request = (turn, data = {}) => ({ kind: RUNNER_RECORDS.request, data: { turn, model: "m", ...data } });
const turn = (turn, data) => ({ kind: RUNNER_RECORDS.turn, data: { turn, ...data } });

test("a request cut by a crash counts at its hold plus its bound, and that bound pauses the run: never a spend_cap_reached end", () => {
  // $0.01 spent, then a request held at $0.25 with a $0.50 bound, cut by a crash (booked cut, its cost unknown): the cap
  // counts $0.76 against $0.50, over by $0.26, within the cut request's $0.50 bound.
  const records = [request(1, { heldUsd: 0.01 }), turn(1, { usd: 0.01, bookedUsd: 0.01, rule: "answered" }), request(2, { heldUsd: 0.25, boundUsd: 0.5 }), turn(2, { usd: null, cut: true })];
  assert.equal(cap.overCapOf(records, 0, 0.5), undefined, "within the cut request's bound: no end, the run pauses at its next request");
});

test("an answer that passed the cap ends the run in the cap's words: the crossing answer booked", () => {
  const records = [request(1, { heldUsd: 0.4 }), turn(1, { usd: 0.7, bookedUsd: 0.7, rule: "answered" })];
  assert.equal(cap.overCapOf(records, 0, 0.5), "spend_cap_reached: The run cost $0.70, $0.20 over its cap of $0.50.");
  // What its other sessions spent counts too.
  assert.equal(cap.overCapOf([request(1, { heldUsd: 0.1 }), turn(1, { usd: 0.3, bookedUsd: 0.3, rule: "answered" })], 0.3, 0.5), "spend_cap_reached: The run cost $0.60, $0.10 over its cap of $0.50.");
});

test("a cache miss past the cap by no more than its request's bound pauses the run; past the bound it ends it", () => {
  // Held at $0.40 with a $0.20 bound: booked $0.55 on a miss, $0.05 over a $0.50 cap, within its bound.
  assert.equal(cap.overCapOf([request(1, { heldUsd: 0.4, boundUsd: 0.2 }), turn(1, { usd: 0.55, bookedUsd: 0.55, rule: "answered" })], 0, 0.5), undefined);
  // Booked $0.80: $0.30 over, past its bound.
  assert.match(cap.overCapOf([request(1, { heldUsd: 0.4, boundUsd: 0.2 }), turn(1, { usd: 0.8, bookedUsd: 0.8, rule: "answered" })], 0, 0.5) ?? "", /^spend_cap_reached: The run cost \$0\.80/);
});

test("within the cap, with no cap's figure unknown, nothing ends", () => {
  assert.equal(cap.overCapOf([request(1, { heldUsd: 0.1 }), turn(1, { usd: 0.1, bookedUsd: 0.1, rule: "answered" })], 0, 0.5), undefined);
  // A spend unknown (a cut request with no hold) reads no end: the cap's own rule refuses the next request for good.
  assert.equal(cap.overCapOf([request(1), turn(1, { usd: null, cut: true })], 0, 0.5), undefined);
});
