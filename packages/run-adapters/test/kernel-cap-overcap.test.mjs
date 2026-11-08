// The over-cap row: a request's cost is booked once it answers, never clipped, so a run can pass its cap by a cache miss
// (by at most the bound of the requests since the cost last fit) or by a hosted tool's allowance. After the usage row that
// passes it, one row says by how much, in cents; none at or under the cap, or with no cap or no known cost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { overCapWords } from "../dist/kernel/cap/index.js";

test("the over-cap row follows the usage row once the booked cost passes the cap, saying by how much; none at or under it", () => {
  assert.equal(overCapWords(1.2345, 1), "Spent $1.23, $0.24 over the run's cap of $1");
  assert.equal(overCapWords(1, 1), undefined);
  assert.equal(overCapWords(0.5, 1), undefined);
  assert.equal(overCapWords(1.2, undefined), undefined, "no cap");
  assert.equal(overCapWords(null, 1), undefined, "no known cost");
});

test("the over-cap row after a cache miss says by how much and the most it could have, in cents, once", () => {
  assert.equal(overCapWords(0.5034, 0.5, 0.012), "Went $0.01 over its cap on a cache miss (at most $0.02).");
  assert.equal(overCapWords(0.53, 0.5, 0.012), "Spent $0.53, $0.03 over the run's cap of $0.50", "past the bound: not a miss");
});
