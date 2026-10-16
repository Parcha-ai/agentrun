// What a parked run's first container (g1) may look like while the run sleeps, read from g1's own record. A sample is
// `docker inspect` of g1 plus the run's other containers at one instant. Until the wake g1 must exist exactly as it parked
// (exited 0, never restarted, the same start); from the wake on the supervisor may remove it (starting g2 removes the run's
// exited containers), and it may do so before g2's container exists: the window between the removal and g2's create is
// whatever the host's load makes it, so nothing here depends on g2 being visible.
export type G1Record = { status: string; exitCode: number; restartCount: number; startedAt: string };
/** `at` is when the sample began (before `docker inspect`), `to` when it ended (after it): the inspection read g1 somewhere between. */
export type WatchSample = { at: number; to: number; g1: G1Record | null; others: string[] };

/** g1 as it parked: exited 0, restart count 0, the same start as when it parked. */
export const asParked = (g1: G1Record | null, parked: { startedAt: string }): boolean =>
  g1 !== null && g1.status === "exited" && g1.exitCode === 0 && g1.restartCount === 0 && g1.startedAt === parked.startedAt;

/**
 * True when g1 was never seen running again or restarted, and was not removed before `wakeAt`. A sample that is g1 gone counts
 * only when its inspection ended at or after the wake (`to`): one that began before the wake may have read after it.
 */
export const g1StayedParked = (samples: readonly WatchSample[], parked: { startedAt: string }, wakeAt: number): boolean =>
  samples.every((s) => asParked(s.g1, parked) || (s.to >= wakeAt && s.g1 === null));
