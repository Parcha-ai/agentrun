// The spend a reopened run reads from its marks. Each step's marks are keyed by its id: a step with an end counts at the
// end's figure; one with only its start (a crash cut it) at what its start held; one whose start holds no figure is
// unknown; a refused step, and one whose end says it never left, count nothing. Each step is counted once, whatever order
// its marks fall in, in full precision.
import type { CapMark, StartMark } from "./marks.js";

/** What the marks say: the cap's spend (null: unknown), the run's reported cost (null once any step's own cost is unknown,
 *  as a step a crash cut), the bound of the steps still open, and how many requests were sent (a refused one is none). */
export type Spend = { spentUsd: number | null; reportedUsd: number | null; boundUsd: number; requests: number };

export function spendOf(marks: readonly CapMark[]): Spend {
  let spent: number | null = 0;
  let reported: number | null = 0;
  let bound = 0;
  let requests = 0;
  const add = (usd: number | null, known: boolean) => {
    spent = spent === null || usd === null ? null : spent + usd;
    reported = reported === null || usd === null || !known ? null : reported + usd;
  };
  /** Each id's step under way (its start, no end yet), and the ids whose last step has its end: read in order, so an id
   *  used again after its step ended is a step of its own, and an end with no step under way is not counted twice. */
  const open = new Map<string, StartMark>();
  const ended = new Set<string>();
  /** Ends read before any start of their id (marks that fall out of order): each closes the start that comes after it. */
  const early = new Set<string>();
  const cut = (start: StartMark) => {
    // A crash cut it: it counts at what it was held at, and no one knows what it cost.
    add(start.heldUsd, false);
    bound += start.boundUsd ?? 0;
  };
  for (const mark of marks) {
    if (mark.kind === "start") {
      if (mark.refused) continue;
      if (!mark.tool) requests++;
      if (early.delete(mark.id)) continue;
      const before = open.get(mark.id);
      if (before) cut(before);
      open.set(mark.id, mark);
      ended.delete(mark.id);
    } else if (mark.kind === "end") {
      if (open.has(mark.id)) {
        open.delete(mark.id);
        ended.add(mark.id);
        add(mark.usd, true);
      } else if (!ended.has(mark.id)) {
        // An end with no start yet (out of order, or a step whose start mark is gone) counts its figure, once, and closes
        // the start of its id that comes after it.
        ended.add(mark.id);
        early.add(mark.id);
        add(mark.usd, true);
      }
    }
  }
  for (const start of open.values()) cut(start);
  return { spentUsd: spent, reportedUsd: reported, boundUsd: bound, requests };
}

/** A run's own priced answers from its marks, as the live cap counts them: each main-model request (never a side call or
 *  a paid call) whose end is an answer with a cost above 0, with its model. */
export function ownCostsOf(marks: readonly CapMark[]): { model: string; usd: number }[] {
  const starts = new Map<string, StartMark>();
  const costs: { model: string; usd: number }[] = [];
  for (const mark of marks) {
    if (mark.kind === "start") starts.set(mark.id, mark);
    else if (mark.kind === "end") {
      const start = starts.get(mark.id);
      if (start?.model && !start.side && !start.tool && mark.rule?.startsWith("answered") && typeof mark.usd === "number" && mark.usd > 0) costs.push({ model: start.model, usd: mark.usd });
    }
  }
  return costs;
}

/** Whether the run's wrap-up was told (a told mark). */
export const toldIn = (marks: readonly CapMark[]): boolean => marks.some((mark) => mark.kind === "told");
