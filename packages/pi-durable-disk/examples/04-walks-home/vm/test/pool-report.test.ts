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

test("code9: one box up and the others not yet placed read as 1 of 3, still placing", () => {
  const r = poolReport(log(["pool.box-ready", 3], ["pool.box-failed", 0], ["pool.box-failed", 1], ["pool.box-failed", 2], ["pool.box-retry", 0], ["pool.box-retry", 1], ["pool.box-retry", 2]), 3);
  assert.equal(readyLine(r), "ready: 1 of 3 GPU boxes (2 still placing)");
});

test("the last event of a box decides: a retried box that came up counts, one that failed again does not", () => {
  const r = poolReport(log(["pool.box-failed", 0], ["pool.box-retry", 0], ["pool.box-ready", 0], ["pool.box-ready", 1], ["pool.box-failed", 2], ["pool.box-retry", 2], ["pool.box-failed", 2]), 3);
  assert.equal(r.up, 2);
  assert.equal(readyLine(r), "ready: 2 of 3 GPU boxes (1 still placing)");
});

test("an empty or cut-off log is nothing up, and does not throw", () => {
  assert.deepEqual(poolReport("", 3), { up: 0, settled: 0, size: 3 });
  assert.deepEqual(poolReport('{"event":"pool.box-ready","index":0}\n{"event":"pool.box-rea', 3), { up: 1, settled: 1, size: 3 });
  assert.equal(readyLine(poolReport("", 3)), "ready: 0 of 3 GPU boxes (3 still placing)");
});

import { shouldAnnounce } from "../pool-report.ts";

test("the ready line is printed when the boxes the demo needs are up, when every box has settled, or when one is up and the grace has passed; boxes Modal is still queuing are not waited for", () => {
  const r = (up: number, settled: number) => ({ up, settled, size: 3 });
  assert.equal(shouldAnnounce(r(3, 3), 4, 10_000, 120_000), true, "all needed boxes up");
  assert.equal(shouldAnnounce(r(0, 0), 4, 10_000, 120_000), false, "nothing yet");
  assert.equal(shouldAnnounce(r(1, 1), 4, 10_000, 120_000), false, "one up, inside the grace: still waiting for the rest");
  assert.equal(shouldAnnounce(r(1, 1), 4, 121_000, 120_000), true, "code9: one up, two minutes on, the other three still in Modal's queue: say 1 of 3 and go on");
  assert.equal(shouldAnnounce(r(0, 4), 4, 5_000, 120_000), true, "every create has settled (all failed): the caller says so");
  assert.equal(shouldAnnounce(r(0, 1), 4, 500_000, 120_000), false, "none up and others still placing: keep waiting, never announce an empty pool");
});
