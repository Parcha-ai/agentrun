// The wrap-up's rule and words: near its cap, a run's next main-model request carries one note telling the model to
// finish, or, before anything is priced, the budget. The cap decides (admit.ts note); a harness only places the words.
import { centsMoney } from "./words.js";

/** Due when what is left is under this many times a priced request's typical cost. */
export const WRAP_UP_FACTOR = 3;
/** Or under this many times the next request's least admission: room for about one more request. */
export const WRAP_UP_LEAST_FACTOR = 2;
/** While nothing is priced (step 0), a request's typical cost is its input and this many output tokens, never its whole
 *  allowance, which no turn uses (the lead's ruling (d), 2026-11-07). */
export const WRAP_UP_STEP0_ANSWER_TOKENS = 4_096;

/** A priced request's typical cost: the median of `costs` after the first (which writes the cache), the one with one,
 *  `nextExpected` with none. A cost not known, or $0, is no priced request. */
export function typicalCost(costs: readonly unknown[], nextExpected: number): number {
  const priced = costs.filter((usd): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd > 0);
  if (priced.length === 0) return nextExpected;
  if (priced.length === 1) return priced[0]!;
  const warm = priced.slice(1).sort((a, b) => a - b);
  const mid = Math.floor(warm.length / 2);
  return warm.length % 2 ? warm[mid]! : (warm[mid - 1]! + warm[mid]!) / 2;
}

/** Whether a run is due its wrap-up: what is left (the cap less spent and held, as admission counts it) under
 *  WRAP_UP_FACTOR times `typical`, or under WRAP_UP_LEAST_FACTOR times the next request's least. */
export function wrapUpDue(cap: number, spent: number, held: number, typical: number, leastUsd?: number): { leftUsd: number } | undefined {
  const leftUsd = cap - spent - held;
  if (!Number.isFinite(leftUsd)) return undefined;
  const byTypical = Number.isFinite(typical) && leftUsd < WRAP_UP_FACTOR * typical;
  const byLeast = leastUsd !== undefined && Number.isFinite(leastUsd) && leftUsd < WRAP_UP_LEAST_FACTOR * leastUsd;
  return byTypical || byLeast ? { leftUsd } : undefined;
}

/** The note's words, what is left to the cent; before any priced request, the budget and a short answer. */
export const wrapUpWords = (leftUsd: number, nonePriced = false): string => {
  const left = centsMoney(Math.max(0, leftUsd));
  return nonePriced ? `This run's budget is about ${left}, enough for little work: answer as soon as you can.` : `About ${left} left of this run's budget: finish now with your answer.`;
};
