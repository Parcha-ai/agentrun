// The cap's wrap-up: a run with a cap whose spend, plus what its requests and paid steps still out hold at their worst
// case, leaves too little to keep back one typical step and one final answer (reserveFor) has every model-issued tool
// call refused before its intent, in WRAP_UP_TEXT (wrapUpText), on every harness and in every conversation of the run (a `subagent`
// spawn is a call too). Nothing in flight is cut, and model requests are not touched: each conversation answers from what
// it has, under the cap, which stays the last line. The figure is read from the run's committed booking records at each
// call (the cap's own: a request still out counts at its hold, one a lost claim cut the same), so a restart or a
// moved claim reads the same figure, and a raise of the cap ends the wrap-up from its next call.

import { leastMoney, money } from "@parcha/agentrun-kernel/kernel/cap";

/** What a call reads once its run's cap is nearly taken: the same words every time, never a count the model could argue with. */
export const WRAP_UP_TEXT = "Budget nearly spent: stop calling tools and answer now from what you have.";

/** A main-model request's figures as the cap prices them (kernel cap requestFigures, its whole input uncached): its
 *  answer at its least, and its step-0 typical cost. */
export type RequestFigures = { readonly leastUsd: number; readonly step0Usd: number };

/** What a run keeps back of its cap so it can still answer: one typical step and one final answer at its least. The
 *  typical step is the run's own priced answers' typical cost (the wrap-up note's figure, kernel cap typicalCost; before
 *  any is priced, the step-0 cost of the request), the answer the cap's least for the main model's next request.
 *  Undefined when the request cannot be priced. The rule's one place. */
export const reserveFor = (figures: RequestFigures | undefined, typical: (step0Usd: number) => number): number | undefined =>
  figures === undefined ? undefined : typical(figures.step0Usd) + figures.leastUsd;

/** Whether a run under `capUsd` that has taken `takenUsd` wraps up. `takenUsd`: its spend and every step still out at its
 *  worst case, as the cap counts them (null: unknown). It wraps up once what it keeps back to answer (`reserveUsd`,
 *  reserveFor) no longer fits on top: in flight is reserved as it stands, so a fan-out keeps room for each conversation to
 *  answer, and a simple run uses its cap up to its last step and answer. No cap, a figure no one knows (the cap refuses
 *  the next request for that), or no reserve yet (no main-model request priced on this claim) is no. */
export const wrappingUp = (capUsd: number | undefined, takenUsd: number | null, reserveUsd: number | undefined): boolean =>
  capUsd !== undefined && takenUsd !== null && reserveUsd !== undefined && Number.isFinite(takenUsd) && Number.isFinite(reserveUsd) && takenUsd + reserveUsd > capUsd;

/** What the run's model needs of a cap for one more step and an answer, by the wrap-up's own rule: a step in flight at
 *  its least (the least the cap can send it with), and what the run keeps back to answer (reserveFor) on top. A cap below
 *  it wraps up at the run's first tool call, whatever was spent. Undefined when the request cannot be priced. */
export const stepAndAnswerFor = (figures: RequestFigures | undefined, typical: (step0Usd: number) => number): number | undefined =>
  figures === undefined ? undefined : figures.leastUsd + reserveFor(figures, typical)!;

/** The sentence that says a cap (`capUsd`) is below what `model`, at `effort` when its request named one, needs for one
 *  more step and an answer (`needUsd`, stepAndAnswerFor), of a run's cap or of an agent's (`whose`); undefined when it is
 *  not below, or the need is unknown. The one wording of the run's wrap-up (wrapUpText) and the agent's save warning. */
export function capBelowText(whose: "run" | "agent", capUsd: number, model: string | undefined, effort: string | undefined, needUsd: number | undefined): string | undefined {
  if (needUsd === undefined || !Number.isFinite(needUsd) || !(needUsd > capUsd)) return undefined;
  const named = `${model ?? "its model"}${effort ? ` at ${effort} effort` : ""}`;
  return `This ${whose}'s cap of ${money(capUsd)} is below what ${named} needs for one more step and an answer, about ${leastMoney(needUsd)}`;
}

/** The words a call reads once its run wraps up: WRAP_UP_TEXT, and on a cap (`capUsd`) below what `model` (at `effort`,
 *  the effort its last request named) needs for one more step and an answer (`needUsd`, stepAndAnswerFor) a sentence
 *  naming them, so whoever reads the run sees that the cap, not the run, ended its tools. The model is told the same and
 *  answers as WRAP_UP_TEXT asks. */
export function wrapUpText(capUsd: number, model: string | undefined, needUsd: number | undefined, effort?: string): string {
  const below = capBelowText("run", capUsd, model, effort, needUsd);
  return below === undefined ? WRAP_UP_TEXT : `${WRAP_UP_TEXT} ${below}.`;
}

/** The warning an agent saved with a cap below what its model needs for one more step and an answer reads (capBelowText):
 *  its runs wrap up at their first tool call. Undefined when the cap holds one. */
export function capBelowWarning(capUsd: number, model: string | undefined, effort: string | undefined, needUsd: number | undefined): string | undefined {
  const below = capBelowText("agent", capUsd, model, effort, needUsd);
  return below === undefined ? undefined : `${below}: a run will wrap up at its first tool call.`;
}
