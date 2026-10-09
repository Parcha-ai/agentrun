// The learning beat's captions, keyed on what a checkpoint's own file reports (its 10 s walk distance, `reported_walk_10s_m`), never on
// wall-clock time and not on the checkpoint's number: which checkpoint crosses each band varies run to run (first steps came at 4.9M steps in
// one rehearsal and 5.9M in another). The wording is the show's, the numbers are the policy file's. The bands are D2's measurement on the take
// body (one H100, 20 runs of 10 s per checkpoint, the tab's arithmetic): checkpoints 1-4 fell in 0 of 20 runs each; checkpoints 1-2 walked
// 0.03-0.06 m, 3-5 walked 0.12-0.42 m, 6 walked 3.59 m, 7-10 walked 4.49-4.76 m. "Lesson 1" says only that: from checkpoint 1 on it stops
// falling. It quotes no fall rate. D2 measured 12 of 20 falls for an untrained network's own exploring moves, but the tab's "untrained" display
// is a different, seeded random signal (it flops within about 2 s), so that number is never put on the screen over it. The thresholds are data
// (change them here), not logic. A checkpoint whose file reports no distance gets only the plain "arrived" line. Nothing here
// promises a stumble: only what the distance says.
export type Band = "fall" | "shuffle" | "steps" | "walk";

export const ARC = {
  /** From this many metres in 10 s it is past "don't fall over" (measured: checkpoints 1-2 walked at most 0.06). */
  shuffleFrom: 0.1,
  /** From this many metres in 10 s it takes first steps (measured: 0.42 below, 3.59 above). */
  stepsFrom: 1,
  /** From this many metres in 10 s it is walking (measured: 4.49 and up; the first steps walked 3.59). */
  walkFrom: 4,
} as const;

export function bandOf(distance: number | null | undefined): Band | null {
  if (distance === null || distance === undefined || !Number.isFinite(distance) || distance < 0) return null;
  return distance < ARC.shuffleFrom ? "fall" : distance < ARC.stepsFrom ? "shuffle" : distance < ARC.walkFrom ? "steps" : "walk";
}

/** The lesson a version teaches, in plain words. */
export function lessonName(band: Band): string {
  if (band === "fall") return "lesson 1: don't fall over";
  if (band === "shuffle") return "lesson 2: shuffling forward";
  if (band === "steps") return "first steps";
  return "walking";
}

/** Metres as people read them: hundredths below a metre (0.17), tenths above (4.8). */
export const metres = (d: number): string => (d < 1 ? d.toFixed(2) : d.toFixed(1));

/**
 * The caption every version gets, in the one fixed window the policy file reports (its walk over 10 simulated seconds), so the versions can be
 * compared at a glance: "Version 4 - lesson 2: shuffling forward - 0.17 m in 10 s". No number the file did not give is invented.
 */
export function versionLine(n: number | undefined, band: Band, distance: number): string {
  return `${n !== undefined ? `Version ${n}` : "A new version"} - ${lessonName(band)} - ${metres(distance)} m in 10 s`;
}
