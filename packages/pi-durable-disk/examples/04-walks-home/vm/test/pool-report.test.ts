// The ready line the person waits for: a count in words against the boxes the demo needs, and what is missing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { poolReport, readyLine } from "../pool-report.ts";

const log = (...events: [string, number][]) => events.map(([event, index]) => JSON.stringify({ at: "x", event, index })).join("\n");

test("all boxes up reads as N of N", () => {
  const r = poolReport(log(["pool.box-ready", 0], ["pool.box-ready", 1], ["pool.box-ready", 2], ["pool.box-ready", 3]), 3);
  assert.deepEqual(r, { up: 4, settled: 4, size: 3 });
  assert.equal(readyLine(r), "ready: 3 of 3 GPU boxes", "a spare does not make it more than the boxes needed");
});

test("code9: one box up and three that did not place read as 1 of 3, still placing, retrying", () => {
  const r = poolReport(log(["pool.box-ready", 3], ["pool.box-failed", 0], ["pool.box-failed", 1], ["pool.box-failed", 2], ["pool.box-retry", 0], ["pool.box-retry", 1], ["pool.box-retry", 2]), 3);
  assert.equal(readyLine(r), "ready: 1 of 3 GPU boxes (2 still placing, retrying)");
});

test("the last event of a box decides: a retried box that came up counts, one that failed again does not", () => {
  const r = poolReport(log(["pool.box-failed", 0], ["pool.box-retry", 0], ["pool.box-ready", 0], ["pool.box-ready", 1], ["pool.box-failed", 2], ["pool.box-retry", 2], ["pool.box-failed", 2]), 3);
  assert.equal(r.up, 2);
  assert.equal(readyLine(r), "ready: 2 of 3 GPU boxes (1 still placing, retrying)");
});

test("an empty or cut-off log is nothing up, and does not throw", () => {
  assert.deepEqual(poolReport("", 3), { up: 0, settled: 0, size: 3 });
  assert.deepEqual(poolReport('{"event":"pool.box-ready","index":0}\n{"event":"pool.box-rea', 3), { up: 1, settled: 1, size: 3 });
  assert.equal(readyLine(poolReport("", 3)), "ready: 0 of 3 GPU boxes (3 still placing, retrying)");
});
