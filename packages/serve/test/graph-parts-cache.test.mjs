// The cache the graph's served parts are kept in (graph-served.ts PartCache): one LRU by bytes across every run, which
// evicts the least recently used part, one at a time, never all at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as served from "../dist/graph-served.js";

test("the parts cache is one LRU by bytes: past its bound the least recently used part goes, never all at once, and a recent part is still kept", () => {
  assert.equal(typeof served.PartCache, "function", "graph-served.ts keeps parts in a PartCache");
  const cache = new served.PartCache(10_000);
  for (let i = 0; i < 20; i++) cache.set(`p${i}`, "x".repeat(900), 1_000);
  // Read p15 again: it is now the most recently used.
  assert.equal(cache.get("p15"), "x".repeat(900));
  for (let i = 20; i < 25; i++) cache.set(`p${i}`, "x".repeat(900), 1_000);
  assert.ok(cache.bytes <= 10_000, String(cache.bytes));
  assert.equal(cache.get("p0"), undefined, "the oldest is gone");
  assert.equal(cache.get("p15"), "x".repeat(900), "the one read recently is kept");
  assert.equal(cache.get("p24"), "x".repeat(900), "the newest is kept");
  assert.ok(cache.size >= 9, `${cache.size} kept: it evicts one at a time, never clears`);
});
