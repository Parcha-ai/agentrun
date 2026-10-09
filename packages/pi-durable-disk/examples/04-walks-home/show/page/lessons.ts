// The learning beat's captions, keyed on what a checkpoint's own file reports (its 10 s walk distance, `reported_walk_10s_m`), never on
// wall-clock time and not on the checkpoint's number: which checkpoint crosses each band varies run to run (first steps came at 4.9M steps in
// one rehearsal and 5.9M in another). The wording is the show's, the numbers are the policy file's. The bands are D2's measurement on the take
// body (one H100, 20 runs of 10 s per checkpoint, the tab's arithmetic): falls went from 12/20 for the untrained brain to 0/20 at the first
// checkpoint; checkpoints 1-2 walked 0.03-0.06 m, 3-5 walked 0.12-0.42 m, 6 walked 3.59 m, 7-10 walked 4.49-4.76 m. The thresholds are data
// (change them here), not logic. A checkpoint whose file reports no distance gets no lesson, only the plain "arrived" line. Nothing here
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

/** The lesson a checkpoint teaches, in plain words. A walking checkpoint has no lesson line: its own caption says how far it went. */
export function lessonFor(band: Band | null): string | null {
  if (band === "fall") return "Lesson 1: don't fall over.";
  if (band === "shuffle") return "Lesson 2: shuffling forward.";
  if (band === "steps") return "First steps.";
  return null;
}
