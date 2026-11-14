// The cap's wrap-up: a run with a cap whose spend, plus what its requests and paid steps still out hold at their worst
// case, leaves too little to keep back one typical step and one final answer (reserveFor) has every model-issued tool
// call refused before its intent, in WRAP_UP_TEXT, on every harness and in every conversation of the run (a `subagent`
// spawn is a call too). Nothing in flight is cut, and model requests are not touched: each conversation answers from what
// it has, under the cap, which stays the last line. The figure is read from the run's committed booking records at each
// call (the cap's own: a request still out counts at its hold and bound, one a lost claim cut the same), so a restart or a
// moved claim reads the same figure, and a raise of the cap ends the wrap-up from its next call.

/** What a call reads once its run's cap is nearly taken: the same words every time, never a count the model could argue with. */
export const WRAP_UP_TEXT = "Budget nearly spent: stop calling tools and answer now from what you have.";

/** A main-model request's figures as the cap prices them (kernel cap requestFigures): its answer at its least, its step-0
 *  typical cost, and its worst (its full asked output). */
export type RequestFigures = { readonly leastUsd: number; readonly step0Usd: number; readonly worstUsd: number };

/** What a run keeps back of its cap so it can still answer: one typical step and one final answer at its least. The
 *  typical step is the run's own priced answers' typical cost (the wrap-up note's figure, kernel cap typicalCost; before
 *  any is priced, the step-0 cost of the request), the answer the cap's least for the main model's next request.
 *  Undefined when the request cannot be priced. The rule's one place: keeping back one final answer at its worst case
 *  instead would be `figures.worstUsd`, and a worst step and a least answer `figures.worstUsd + figures.leastUsd`. */
export const reserveFor = (figures: RequestFigures | undefined, typical: (step0Usd: number) => number): number | undefined =>
  figures === undefined ? undefined : typical(figures.step0Usd) + figures.leastUsd;

/** Whether a run under `capUsd` that has taken `takenUsd` wraps up. `takenUsd`: its spend and every step still out at its
 *  worst case, as the cap counts them (null: unknown). It wraps up once what it keeps back to answer (`reserveUsd`,
 *  reserveFor) no longer fits on top: in flight is reserved as it stands, so a fan-out keeps room for each conversation to
 *  answer, and a simple run uses its cap up to its last step and answer. No cap, a figure no one knows (the cap refuses
 *  the next request for that), or no reserve yet (no main-model request priced on this claim) is no. */
export const wrappingUp = (capUsd: number | undefined, takenUsd: number | null, reserveUsd: number | undefined): boolean =>
  capUsd !== undefined && takenUsd !== null && reserveUsd !== undefined && Number.isFinite(takenUsd) && Number.isFinite(reserveUsd) && takenUsd + reserveUsd > capUsd;
