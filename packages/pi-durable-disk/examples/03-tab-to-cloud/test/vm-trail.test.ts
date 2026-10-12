// The instance's trail: what it reports of its lease and its health, and that reporting can never fail or delay the lease.
import assert from "node:assert/strict";
import { test } from "node:test";
import { vmTrail } from "../vm-trail.ts";

const collect = () => {
  const lines: { event: string; data: Record<string, unknown> }[] = [];
  return { lines, send: (event: string, data: Record<string, unknown> = {}) => void lines.push({ event, data }) };
};

test("a heartbeat write at or over the slow bound is reported, a quick one is not, a failed one always is", () => {
  const { lines, send } = collect();
  const trail = vmTrail(send, { slowBeatMs: 1_000 });
  trail.onLease({ kind: "beat", ok: true, ms: 40 });
  trail.onLease({ kind: "beat", ok: true, ms: 2_400 });
  trail.onLease({ kind: "beat", ok: false, ms: 0, error: "EIO" });
  assert.deepEqual(lines, [
    { event: "lease.slow-beat", data: { ms: 2_400 } },
    { event: "lease.beat-failed", data: { error: "EIO" } },
  ]);
});

test("a fence is always reported, with its reason and how long since the last good heartbeat started", () => {
  const { lines, send } = collect();
  vmTrail(send).onLease({ kind: "fence", code: "LEASE_LAPSED", message: "the last successful heartbeat started 7300 ms ago", sinceMs: 7_300, by: "timer" });
  assert.deepEqual(lines, [{ event: "lease.fence", data: { code: "LEASE_LAPSED", message: "the last successful heartbeat started 7300 ms ago", sinceMs: 7_300, by: "timer" } }]);
});

test("the health line carries the loop delay, memory and the heartbeat's durations, then resets what it measured", async () => {
  const { lines, send } = collect();
  const trail = vmTrail(send);
  trail.onLease({ kind: "beat", ok: true, ms: 120 });
  trail.onLease({ kind: "beat", ok: true, ms: 300 });
  const stop = trail.startHealth(40);
  await new Promise((r) => setTimeout(r, 130));
  stop();
  const health = lines.filter((l) => l.event === "vm.health");
  assert.ok(health.length >= 2, "a line every interval");
  const first = health[0]!.data;
  assert.equal(first.beats, 2);
  assert.equal(first.lastBeatMs, 300);
  assert.equal(first.slowestBeatMs, 300);
  for (const key of ["loopDelayMaxMs", "loopDelayMeanMs", "rssMB", "heapMB", "freeMemMB", "load1"]) assert.equal(typeof first[key], "number", key);
  assert.equal(health[1]!.data.slowestBeatMs, 0, "the slowest beat is per interval");
});

test("a sender that throws changes nothing for the lease", () => {
  const trail = vmTrail(() => {
    throw new Error("the link is gone");
  });
  trail.onLease({ kind: "beat", ok: true, ms: 5_000 });
  trail.onLease({ kind: "fence", code: "LEASE_LAPSED", message: "x" });
});
