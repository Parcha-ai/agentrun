// The spend a reopened run reads from its marks. Each step's marks are keyed by its id: a step with an end counts at the
// end's figure; one with only its start (a crash cut it) at what its start held; one whose start holds no figure is
// unknown; a refused step, and one whose end says it never left, count nothing. Each step is counted once, whatever order
// its marks fall in, in full precision.
import type { CapMark, StartMark } from "./marks.js";

/** What the marks say: the cap's spend (null: unknown), the run's reported cost (null once any step's own cost is unknown,
 *  as a step a crash cut), the bound of the steps still open, and how many requests were sent (a refused one is none). */
export type Spend = { spentUsd: number | null; reportedUsd: number | null; boundUsd: number; requests: number };

export function spendOf(marks: readonly CapMark[]): Spend {
  const starts = new Map<string, StartMark>();
  const ends = new Map<string, number | null>();
  for (const mark of marks) {
    if (mark.kind === "start") starts.set(mark.id, mark);
    else if (!ends.has(mark.id)) ends.set(mark.id, mark.usd);
  }
  let spent: number | null = 0;
  let reported: number | null = 0;
  let bound = 0;
  let requests = 0;
  const add = (usd: number | null, known: boolean) => {
    spent = spent === null || usd === null ? null : spent + usd;
    reported = reported === null || usd === null || !known ? null : reported + usd;
  };
  for (const [id, start] of starts) {
    if (start.refused) continue;
    if (!start.tool) requests++;
    if (ends.has(id)) {
      add(ends.get(id)!, true);
    } else {
      // Open: a crash cut it. It counts at what it was held at, and no one knows what it cost.
      add(start.heldUsd, false);
      bound += start.boundUsd ?? 0;
    }
  }
  // An end with no start (written by a step whose start mark is gone) still counts its figure.
  for (const [id, usd] of ends) if (!starts.has(id)) add(usd, true);
  return { spentUsd: spent, reportedUsd: reported, boundUsd: bound, requests };
}
