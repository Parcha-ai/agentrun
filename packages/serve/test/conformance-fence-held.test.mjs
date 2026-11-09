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

/** #1979's CI, node 24 (job 128921560458), the runner process's own events as the failing check printed them: its first
 *  claim lapsed unrenewed before the point, the run was taken again as epoch 2, whose loop held at the point, went on, and
 *  its write was refused (Fenced) as that claim was said lost. */
const CI_STARVED = [{"runner":"runner-process","at":1794185967715,"type":"claimed","claim":{"runId":"run-1","runner":"runner-process","epoch":1,"until":1794185968313,"from":"queued"}},{"runner":"runner-process","at":1794185967781,"type":"commit-landed","epoch":1},{"runner":"runner-process","at":1794185967810,"type":"commit-landed","epoch":1},{"runner":"runner-process","at":1794185967850,"type":"commit-landed","epoch":1},{"runner":"runner-process","at":1794185967870,"type":"commit-landed","epoch":1},{"runner":"runner-process","at":1794185967878,"type":"commit-landed","epoch":1},{"runner":"runner-process","at":1794185967904,"type":"commit-landed","epoch":1},{"runner":"runner-process","at":1794185968287,"type":"claim-lost","runId":"run-1","epoch":1,"why":"not-renewed"},{"runner":"runner-process","at":1794185968296,"type":"commit-landed","epoch":1},{"runner":"runner-process","at":1794185968909,"type":"claimed","claim":{"runId":"run-1","runner":"runner-process","epoch":2,"until":1794185969506,"from":"running"}},{"runner":"runner-process","at":1794185968926,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185968975,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185969032,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185970984,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185970992,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185971002,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185971037,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185971067,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185971079,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185971084,"type":"commit-landed","epoch":2},{"runner":"runner-process","at":1794185971087,"type":"stopping","point":"beforeIntent"},{"runner":"runner-process","at":1794185971994,"type":"continued","point":"beforeIntent"},{"runner":"runner-process","at":1794185972003,"type":"claim-lost","runId":"run-1","epoch":2,"why":"not-renewed"},{"runner":"runner-process","at":1794185972005,"type":"commit-refused","epoch":2,"name":"Fenced"},{"runner":"runner-process","at":1794185972010,"type":"claimed","claim":{"runId":"run-1","runner":"runner-process","epoch":3,"until":1794185972609,"from":"running"}}];
/** When the case let it go: just before the process said it continued (the case's clock reads before its SIGCONT). */
const CI_WENT_ON = 1794185971994 - 1;

test("CI's starved order: a process that lost its first claim before the hook is read under the claim its held loop ran under", () => {
  fenceHeld(CI_STARVED, CI_WENT_ON);
  // The same order with that loop's write landing instead fails, naming the held claim's epoch.
  const landed = CI_STARVED.map((event) => (event.type === "commit-refused" ? { ...event, type: "commit-landed", name: undefined } : event));
  assert.throws(() => fenceHeld(landed, CI_WENT_ON), /an epoch-2 commit landed 2 ms after its claim was lost/);
});

test("a write of the old epoch that lands after the claim was lost fails, saying how long after", () => {
  assert.throws(() => fenceHeld([claimed, lost, { at: WENT_ON + 8, type: "commit-landed", epoch: 1 }], WENT_ON), /an epoch-1 commit landed 3 ms after its claim was lost/);
});

test("a process that neither tried a write nor said its claim was lost once it went on fails", () => {
  assert.throws(() => fenceHeld([claimed, { ...lost, at: WENT_ON - 1 }], WENT_ON), /^AssertionError.*: the old loop /);
  assert.throws(() => fenceHeld([claimed], WENT_ON), /^AssertionError.*: the old loop /);
});
