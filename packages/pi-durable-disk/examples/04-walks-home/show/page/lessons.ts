// The learning beat's captions, keyed on what a checkpoint's own file reports (its 10 s walk distance, `reported_walk_10s_m`) and the
// checkpoint number, never on wall-clock time: a run that learns faster or slower stays true. The wording is the show's, the numbers are
// the policy file's. The bands are the show's reading of D2's measured checkpoints on the take body (H100, 512 envs): checkpoints 1-2 walked
// 0.03-0.05 m in 10 s, 3-5 walked 0.12-0.19 m, 6 walked 3.1 m (the first wobbly steps), 7-10 walked 4.0-4.9 m. The thresholds sit in the
// gaps between those groups. They are data (change them here), not logic. A checkpoint whose file reports no distance gets no lesson, only
// the plain "arrived" line. Nothing here promises a stumble: only what the distance says.
export type Band = "fall" | "shuffle" | "walk";

export const ARC = {
  /** Below this many metres in 10 s the creature has not yet learned to keep its feet (measured: 0.03-0.05). */
  shuffleFrom: 0.1,
  /** From this many metres in 10 s it is walking (measured: 3.1 and up; the checkpoints below it walked at most 0.19). */
  walkFrom: 1,
} as const;

export function bandOf(distance: number | null | undefined): Band | null {
  if (distance === null || distance === undefined || !Number.isFinite(distance) || distance < 0) return null;
  return distance < ARC.shuffleFrom ? "fall" : distance < ARC.walkFrom ? "shuffle" : "walk";
}

/** The lesson a checkpoint teaches, in plain words; the first walking checkpoint is "First steps."; later walking ones have no lesson line (the walk caption follows). */
export function lessonFor(band: Band | null, firstWalking: boolean): string | null {
  if (band === "fall") return "Lesson 1: don't fall over.";
  if (band === "shuffle") return "Lesson 2: shuffling forward.";
  if (band === "walk") return firstWalking ? "First steps." : null;
  return null;
}
