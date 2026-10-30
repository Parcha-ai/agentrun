// A run's cost in its views, on its own: the rows' usage row, else what the store kept.
import assert from "node:assert/strict";
import { test } from "node:test";
import { costSource, costView } from "../dist/runs.js";

const usage = (usd, requests = 1) => ({ id: "1:usage", kind: "usage", summary: "", usage: { usd, requests } });

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

test("cost.source is reported only for a known cost whose every part a provider reported: an unknown cost (usd null) is always estimate", () => {
  assert.equal(costSource([], true, 0.00003), "reported", "decisions alone, each reported, and no model request");
  assert.equal(costSource([usage(0, 0)], true, 0.00003), "reported", "a usage row that made no request is no model request");
  assert.equal(costSource([], true, null), "estimate", "every decision says reported, yet the cost is unknown");
  assert.equal(costSource([usage(0.0001)], true, 0.00013), "estimate", "a model request is this server's estimate");
  assert.equal(costSource([], false, 0.00003), "estimate", "a decision booked at a list price");
  assert.equal(costSource([], undefined, 0), "estimate", "a run that made no decision");
});
