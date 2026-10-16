// The parking test's check that g1 never restarted (test/live/docker-park.live.test.ts), on samples made up to hold what a
// loaded host does and the live suite cannot hold still: the supervisor removes g1 when it starts g2, and g2's container may
// not exist for seconds after.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asParked, g1StayedParked, type G1Record, type WatchSample } from "./live/_park-watch.ts";

const parked = { startedAt: "2026-10-16T00:00:00.000Z" };
const g1: G1Record = { status: "exited", exitCode: 0, restartCount: 0, startedAt: parked.startedAt };
const wakeAt = 90_000;
/** One sample every 2 s from 2 s to 100 s. */
const run = (state: (at: number) => Pick<WatchSample, "g1" | "others">): WatchSample[] => Array.from({ length: 50 }, (_, i) => ({ at: (i + 1) * 2_000, to: (i + 1) * 2_000 + 50, ...state((i + 1) * 2_000) }));

/** The check before this change: g1 absent only from the first sample that sees another container. */
const legacy = (samples: WatchSample[]): boolean => {
  const g2At = samples.find((w) => w.others.length > 0)?.at ?? Number.POSITIVE_INFINITY;
  return samples.every((w) => asParked(w.g1, parked) || (w.at >= g2At && w.g1 === null));
};

test('g1 removed when g2 is started and g2\'s create comes seconds later: the old check says g1 restarted, the record says it never did', () => {
  // g1 parked until the wake, removed at 92 s, and g2's container shows only from 96 s.
  const delayed = run((at) => (at < 92_000 ? { g1, others: [] } : at < 96_000 ? { g1: null, others: [] } : { g1: null, others: ["g2"] }));
  assert.equal(legacy(delayed), false, 'the old check read the window between the removal and g2\'s create as a restart');
  assert.equal(g1StayedParked(delayed, parked, wakeAt), true);
});

test('g1 removed and g2 created in the same tick still passes', () => {
  assert.equal(g1StayedParked(run((at) => (at < 92_000 ? { g1, others: [] } : { g1: null, others: ["g2"] })), parked, wakeAt), true);
});

test('a g1 that was restarted, ran again, started anew or was removed before the wake fails', () => {
  const after = (state: Pick<WatchSample, "g1" | "others">) => run((at) => (at < 80_000 ? { g1, others: [] } : state));
  assert.equal(g1StayedParked(after({ g1: { ...g1, restartCount: 1 }, others: [] }), parked, wakeAt), false, 'restart count 1');
  assert.equal(g1StayedParked(after({ g1: { ...g1, status: "running" }, others: [] }), parked, wakeAt), false, 'running again');
  assert.equal(g1StayedParked(after({ g1: { ...g1, startedAt: "2026-10-16T00:00:50.000Z" }, others: [] }), parked, wakeAt), false, 'a new start');
  assert.equal(g1StayedParked(after({ g1: { ...g1, exitCode: 1 }, others: [] }), parked, wakeAt), false, 'exit 1');
  assert.equal(g1StayedParked(after({ g1: null, others: [] }), parked, wakeAt), false, 'gone before the wake (from 80 s, the wake is at 90 s)');
});

test('an inspection that started before the wake and read after it may find g1 removed: a stall across the wake is not a restart', () => {
  // The watcher stamps the sample before `docker inspect` runs. On a loaded host the inspect stalls past the wake (90 s), and the
  // supervisor has removed g1 by the time it reads: a pre-wake stamp with g1 gone.
  const stalled: WatchSample[] = [...run((at) => (at < 88_000 ? { g1, others: [] } : { g1: null, others: [] })).filter((s) => s.at < 88_000), { at: 89_500, to: 90_800, g1: null, others: [] }, { at: 92_000, to: 92_050, g1: null, others: ["g2"] }];
  assert.equal(g1StayedParked(stalled, parked, wakeAt), true);
  // Read entirely before the wake and found gone: removed early.
  assert.equal(g1StayedParked([...stalled.slice(0, -2), { at: 85_000, to: 85_200, g1: null, others: [] }], parked, wakeAt), false);
  // Across the wake but g1 present and changed: still a failure.
  assert.equal(g1StayedParked([{ at: 89_500, to: 90_800, g1: { ...g1, restartCount: 1 }, others: [] }], parked, wakeAt), false);
});
