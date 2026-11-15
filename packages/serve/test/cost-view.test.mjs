// A run's cost in its views, on its own: the rows' usage row, else what the store kept.
import assert from "node:assert/strict";
import { test } from "node:test";
import { costWordsOfView } from "../dist/run-view.js";

const usage = (usd, requests = 1) => ({ id: "1:usage", kind: "usage", summary: "", usage: { usd, requests } });
const costView = (rows, stored) => costWordsOfView(rows, stored).usd;

test("a run's cost is its usage row's; with none, what the store kept, and $0 before any request", () => {
  assert.equal(costView([usage(0.02)], 0.5), 0.02);
  assert.equal(costView([], undefined), 0);
  assert.equal(costView([], 0.5), 0.5);
});

test("a usage row that says unknown reads unknown, never the store's figure from before a follow-up", () => {
  // A completed run carried back at $0.0009, then opened again; its follow-up's request was cut, so its rows say unknown.
  assert.equal(costView([usage(0.0009), usage(null, 2)], 0.0009), null);
  assert.equal(costView([usage(null, 2)], undefined), null);
});

test("a usage row without its usage reads unknown, never the store's figure", () => {
  assert.equal(costView([{ id: "1:usage", kind: "usage", summary: "" }], 0.0009), null);
});

test("a usage row whose cost counts a hold, joined with decisions: one of no known cost leaves the exact part alone known; every one known keeps the bound", () => {
  const bound = { id: "1:usage", kind: "usage", summary: "", usage: { usd: 0.26, requests: 2, so_far_usd: 0.01, unpriced: 1, upper_bound: true } };
  assert.deepEqual(costWordsOfView([bound], undefined, { known: 0, bounded: 0, atMost: 0, unpriced: 1 }), { usd: null, so_far_usd: 0.01, unpriced: 2 });
  assert.deepEqual(costWordsOfView([bound], undefined, { known: 0.02, bounded: 0, atMost: 0, unpriced: 0 }), { usd: 0.28, so_far_usd: 0.03, unpriced: 1, upper_bound: true });
  // A bound that says no exact part (no row of this server's): none of it is spend.
  const bare = { ...bound, usage: { usd: 0.26, requests: 2, upper_bound: true } };
  assert.deepEqual(costWordsOfView([bare], undefined, { known: 0, bounded: 0, atMost: 0, unpriced: 1 }), { usd: null, so_far_usd: 0, unpriced: 2 });
});
