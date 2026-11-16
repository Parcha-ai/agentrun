// The budget card of a run parked at its cap (run-view.ts budgetOf), under the one worst-case cap: it carries no
// overshoot bound, since a request held at its worst case has none to pass the cap by, and a figure of nothing reads 0,
// never -0, which the card would print as "-0".
import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetOf, micro } from "../dist/run-view.js";

const run = { meta: { max_cost_usd: 0.05 }, rows: [], updatedAt: new Date(0).toISOString() };
const park = (pending) => ({ id: 7, kind: "agentrun.budget", data: { pending: { kind: "budget", cap_usd: 0.05, ...pending }, words: "The run's next request could cost up to $0.06." } });

test("a parked run's budget card carries no overshoot bound, and nothing spent reads 0, never -0", () => {
  const card = budgetOf([park({ spent_usd: 0, needs_usd: 0.06 })], run);
  assert.equal("overshoot_bound_usd" in card, false, JSON.stringify(card));
  assert.ok(Object.is(card.spent_usd, 0), `spent_usd is ${Object.is(card.spent_usd, -0) ? "-0" : card.spent_usd}`);
  assert.deepEqual([card.cap_usd, card.needs_usd], [0.05, 0.06], JSON.stringify(card));
});

test("a figure to a millionth rounds to the nearest millionth", () => {
  assert.equal(micro(0.0123451), 0.012345);
  assert.equal(micro(0.0123456), 0.012346);
  assert.equal(micro(0.012345), 0.012345, "a whole millionth stays as it is");
});
