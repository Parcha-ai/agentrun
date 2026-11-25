// sessionSpendOf's chargedUsd: what a session's answered requests were charged, never a request still in flight at its
// hold. A host reads it for a run that ended settled (serve's adapter loop), beside spentUsd, which counts the open ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNNER_RECORDS, sessionSpendOf } from "@parcha/agentrun-kernel";

const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);
const asked = (turn, heldUsd) => ({ kind: RUNNER_RECORDS.request, data: { turn, ...(heldUsd === undefined ? {} : { heldUsd }) } });
const answered = (turn, data) => ({ kind: RUNNER_RECORDS.turn, data: { turn, ...data } });

test("chargedUsd counts the answered requests alone; spentUsd also counts one still in flight at its hold", () => {
  const read = sessionSpendOf([asked(1, 0.5), answered(1, { usd: 0.01 }), asked(2, 0.5)]);
  near(read.chargedUsd, 0.01, "charged: the answered one");
  near(read.spentUsd, 0.51, "spent: the open one at its hold too");
});

test("a request a crash cut is charged at its hold, as it is counted for the cap", () => {
  const read = sessionSpendOf([asked(1, 0.5), answered(1, { usd: 0.01 }), asked(2, 0.5), answered(2, { cut: true })]);
  near(read.chargedUsd, 0.51, "the cut one at its hold");
  near(read.spentUsd, 0.51, "the same: nothing is open");
});

test("an answered request with no figure leaves the charge unknown, never $0", () => {
  const read = sessionSpendOf([asked(1), answered(1, { usd: null }), asked(2, 0.5), answered(2, { usd: 0.02 })]);
  assert.equal(read.chargedUsd, null);
});

test("no requests: nothing charged", () => {
  assert.equal(sessionSpendOf([]).chargedUsd, 0);
});
