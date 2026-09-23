// The TypeScript interpreter agrees with the Lean model (spec/lean) on every conformance
// case: validation verdict, outcome, final state, output, escalation, error and the
// per-execution-path control-flow events. The Lean side checks the same `expected` blocks
// with `lake exe conformance`.
import assert from "node:assert/strict";
import test from "node:test";
import { loadCases, runCase } from "./lean-conformance-harness.mjs";

const cases = loadCases();

test("the Lean conformance corpus is present", () => {
  assert.ok(cases.length >= 10, `expected conformance cases, found ${cases.length}`);
});

for (const { file, case: c } of cases) {
  test(`lean conformance: ${file}`, async () => {
    const { expected, codeReturns } = await runCase(c);
    assert.deepEqual(expected, c.expected);
    // The Lean model cannot run JavaScript: the case scripts each code node's return value,
    // and it must be what the real code returned.
    for (const [path, entry] of Object.entries(codeReturns)) assert.deepEqual(c.script?.code?.[path], JSON.parse(JSON.stringify(entry)), `code return at ${path}`);
  });
}
