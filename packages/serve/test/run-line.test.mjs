// The log line of a runner's start/end event (print.ts runLine): an unknown cost stays unknown, and a cancel is no stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runLine } from "../dist/print.js";
import { endedStatus } from "../dist/runner/runner.js";

const fields = (line) => Object.fromEntries(line.split(" ").map((part) => part.split("=")));

test("an end whose cost is unknown says cost_usd=unknown, never 0", () => {
  const line = runLine({ type: "ended", runId: "r1", agent: "a", status: "ended", costUsd: null });
  assert.equal(fields(line).cost_usd, "unknown");
  assert.equal(fields(runLine({ type: "ended", runId: "r1", agent: "a", status: "ended", costUsd: 0 })).cost_usd, "0");
});

test("endedStatus: a stop with outcome cancelled is a cancel; a person's stop and the other finals keep their state", () => {
  assert.equal(endedStatus({ state: "stopped", outcome: "cancelled" }), "cancelled");
  assert.equal(endedStatus({ state: "stopped", outcome: "stopped" }), "stopped");
  assert.equal(endedStatus({ state: "ended", outcome: "completed" }), "ended");
  assert.equal(endedStatus({ state: "failed", outcome: null }), "failed");
});

test("a cancelled run says status=cancelled, a stopped one status=stopped", () => {
  assert.equal(fields(runLine({ type: "ended", runId: "r1", agent: "a", status: "cancelled", costUsd: 0 })).status, "cancelled");
  assert.equal(fields(runLine({ type: "ended", runId: "r1", agent: "a", status: "stopped", costUsd: 0 })).status, "stopped");
});
