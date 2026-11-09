// What a refusal does to the run, and what a raise does. A refusal for room parks the run (the loop's LoopEnd parked)
// with what it needs: its pending figures, as the run serves them to a millionth, and the raise its words name; a refusal
// no raise could fix fails it. A raise is checked here, the same rule wherever it comes from: a number above the run's
// cap by more than a float's tail; the same raise again is a retry that changes nothing and answers as the first did,
// unless the run has since parked anew under it. Raises taken together resume the run once, at the latest cap, with one
// follow-up in the server's words.
import type { CapRefused } from "./admit.js";
import { CAP_TOLERANCE } from "./price.js";
import { CAP_REFUSAL_CODE, money, suggestedRaise } from "./words.js";

const micro = (usd: number): number => Math.round(usd * 1e6) / 1e6;
/** A bound to a millionth, rounded up (never under what it bounds), as main's overshoot bound is (run-view.ts microUp);
 *  no bound is 0, never -0 (the ceiling of a hair under 0 is -0, which a card would print as "-0"). */
const microUp = (usd: number): number => Math.ceil(usd * 1e6 - 1e-9) / 1e6 + 0;

/** A run parked at its cap waits on a raise: its cap, what the cap counted as taken, the least the refused step needs, the
 *  least cap that sends it, the raise it is offered, and the most a cache miss could have added to the refused step
 *  (`bound_usd`, the refusal's boundUsd; 0 when it named none), which the budget card shows as main's overshoot bound. */
export type BudgetPending = { kind: "budget"; cap_usd: number; spent_usd: number; needs_usd: number; least_cap_usd: number; suggested_cap_usd: number; bound_usd: number };

export type Park =
  | { outcome: "parked"; pending: BudgetPending; words: string; event: { kind: "pause"; text: string }; error?: undefined }
  | { outcome: "failed"; error: string; pending?: undefined };

/** The run's end for `refusal` under `capUsd`. */
export function parkOf(refusal: CapRefused, capUsd: number): Park {
  if (refusal.forGood || !refusal.figures) return { outcome: "failed", error: refusal.message };
  const { spentUsd, needsUsd, leastCapUsd, boundUsd } = refusal.figures;
  const words = refusal.message.startsWith(CAP_REFUSAL_CODE) ? refusal.message.slice(CAP_REFUSAL_CODE.length) : refusal.message;
  return {
    outcome: "parked",
    pending: { kind: "budget", cap_usd: capUsd, spent_usd: micro(spentUsd), needs_usd: micro(needsUsd), least_cap_usd: leastCapUsd, suggested_cap_usd: suggestedRaise(capUsd, spentUsd, needsUsd), bound_usd: microUp(boundUsd ?? 0) },
    words,
    event: { kind: "pause", text: words },
  };
}

/** What a raise meets: the run's cap, whether it is final, the pause it waits at (none while it works), and its last raise
 *  (with the pause that one answered). */
export type RaiseState = { capUsd: number | undefined; final?: boolean; pause?: string | undefined; lastRaise?: { to: number; pause?: string | undefined } };
export type RaiseCheck =
  | { raised: true; resumes: boolean; pause?: string; refused?: undefined; retry?: undefined }
  | { retry: true; resumed: boolean; raised?: undefined; refused?: undefined }
  | { refused: string; raised?: undefined; retry?: undefined };

export function checkRaise(state: RaiseState, raiseUsd: number): RaiseCheck {
  const from = state.capUsd;
  if (from === undefined) return { refused: "This run has no cap to raise: a cap is named when a run starts." };
  if (state.final) return { refused: "This run has ended: it takes no raise." };
  if (typeof raiseUsd !== "number" || !Number.isFinite(raiseUsd)) return { refused: "A raise is a number of dollars." };
  const last = state.lastRaise;
  // The same raise again (a retry): what the first did stands. Resumed, as the first answer said, unless the run has
  // since parked anew at another refusal: that pause is not this raise's.
  if (Math.abs(raiseUsd - from) <= CAP_TOLERANCE && last && Math.abs(last.to - raiseUsd) <= CAP_TOLERANCE) {
    return { retry: true, resumed: last.pause !== undefined && (state.pause === undefined || state.pause === last.pause) };
  }
  if (!(raiseUsd > from + CAP_TOLERANCE)) return { refused: `A cap is only raised: name more than the run's ${money(from)}.` };
  return state.pause === undefined ? { raised: true, resumes: false } : { raised: true, resumes: true, pause: state.pause };
}

/** The follow-up a raised parked run goes on with: the server's words, never the person's. */
export const followUpOf = (capUsd: number): { text: string; author: "server"; reason: "cap_raised" } => ({ text: `The cap was raised to ${money(capUsd)}; continue the task.`, author: "server", reason: "cap_raised" });

/** Raise commands taken together (in id order, by the claim that wakes the run): each checked against the state the ones
 *  before it left; the run resumes once, at the latest cap, with one follow-up. */
export function takeRaises(state: RaiseState, raises: readonly { id: number; usd: number }[]) {
  let current = { ...state };
  let resumes = false;
  const results: Array<{ id: number } & RaiseCheck> = [];
  for (const raise of raises) {
    const check = checkRaise(current, raise.usd);
    results.push({ id: raise.id, ...check });
    if (check.raised) {
      resumes ||= check.resumes;
      current = { ...current, capUsd: raise.usd, lastRaise: { to: raise.usd, pause: current.pause } };
    }
  }
  const capUsd = current.capUsd;
  const followUp = resumes && capUsd !== undefined ? followUpOf(capUsd) : undefined;
  return { capUsd, results, followUps: followUp ? 1 : 0, ...(followUp ? { followUp } : {}) };
}
