// The served view's money to a millionth (run-view.ts): a bound rounded up so "at most" holds, and no bound is 0, never
// -0, which a budget card would print as "-0".
import assert from "node:assert/strict";
import { test } from "node:test";
import { microUp } from "../dist/run-view.js";

test("a bound of nothing is 0, never -0; a bound rounds up to a millionth", () => {
  assert.ok(Object.is(microUp(0), 0), `microUp(0) is ${Object.is(microUp(0), -0) ? "-0" : microUp(0)}`);
  assert.equal(microUp(0.0123451), 0.012346);
  assert.equal(microUp(0.012345), 0.012345, "a whole millionth stays as it is");
});
