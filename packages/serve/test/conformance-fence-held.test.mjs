// The stalled case's fence check (conformance/harness.ts fenceHeld), read on the runner process's own events. Once the
// process went on, its lease run out, the fence is kept in one of two ways, and which one a box shows is its timing:
// the old loop's write is tried and refused by the fence, by name; or the runner sees its claim lost and stops the loop
// before it writes at all. Both pass, deterministically; a write of the old epoch that lands fails, saying how long after
// the claim was lost; and a process that neither tried a write nor said its claim was lost fails.
import assert from "node:assert/strict";
import { test } from "node:test";

const { fenceHeld } = await import("../dist/runner/conformance/harness.js");

const WENT_ON = 10_000;
const claimed = { runner: "runner-process", at: 1_000, type: "claimed", claim: { runId: "run-1", runner: "runner-process", epoch: 1 } };
const lost = { runner: "runner-process", at: WENT_ON + 5, type: "claim-lost", runId: "run-1", epoch: 1, why: "not-renewed" };

test("a write the old loop tried once it went on, refused by the fence by name, keeps the fence", () => {
  fenceHeld([claimed, { at: WENT_ON + 3, type: "commit-refused", epoch: 1, name: "Fenced" }, lost], WENT_ON);
});

test("a loop the runner stopped before any write, its claim said lost once it went on, keeps the fence (a loaded box's order)", () => {
  // CI's order on a loaded runner: the lapsed lease is seen and the loop stopped before its intent is committed.
  fenceHeld([claimed, lost], WENT_ON);
});

test("a write of the old epoch that lands after the claim was lost fails, saying how long after", () => {
  assert.throws(() => fenceHeld([claimed, lost, { at: WENT_ON + 8, type: "commit-landed", epoch: 1 }], WENT_ON), /an epoch-1 commit landed 3 ms after its claim was lost/);
});

test("a process that neither tried a write nor said its claim was lost once it went on fails", () => {
  assert.throws(() => fenceHeld([claimed, { ...lost, at: WENT_ON - 1 }], WENT_ON), /^AssertionError.*: the old loop /);
  assert.throws(() => fenceHeld([claimed], WENT_ON), /^AssertionError.*: the old loop /);
});
