// The over-cap row: a request's cost is booked once it answers, never clipped. A request is held at its worst case, a cache
// miss included, so only a charge past its hold (a hosted tool's usage-priced charge) can pass the cap. After the usage
// row that passes it, one row says by how much, in cents; none at or under the cap, or with no cap or no known cost.
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

test("no row excuses a spend past the cap as a cache miss: a cent over reads as any spend over", () => {
  assert.equal(overCapWords(0.5034, 0.5), "Spent $0.50, $0.01 over the run's cap of $0.50");
  assert.equal(overCapWords(0.53, 0.5), "Spent $0.53, $0.03 over the run's cap of $0.50");
});
