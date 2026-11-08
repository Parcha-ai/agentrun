// The kernel cap's words, as a person who has never seen a model request reads them: what the run spent (and holds for
// steps still running) of its cap, what the next step needs at the least, and the cap to raise to, to continue. A
// refusal for room begins CAP_REFUSAL_CODE ("out of budget", which keeps it final to pi-ai's retry whatever digits its
// words hold); a refusal no cap could fix begins the bare code.
import { CAP_TOLERANCE, FIT_TOLERANCE } from "./price.js";
import type { RefusalFigures } from "./types.js";

/** What every refusal begins with. */
export const SPEND_CAP_REACHED = "spend_cap_reached";
/** What a refusal for room begins with. */
export const CAP_REFUSAL_CODE = `${SPEND_CAP_REACHED} (out of budget): `;
/** How many of the refused request's least a run parked at its cap is offered on top of what was taken. */
export const SUGGESTED_RAISE_FACTOR = 10;

/** An amount in words: a whole number of dollars as given ($1), else two decimals or as many as it takes, up to eight. */
export function money(usd: number): string {
  if (Number.isInteger(usd)) return `$${usd}`;
  for (let digits = 2; digits < 8; digits++) if (Number(usd.toFixed(digits)) === Number(usd.toFixed(8))) return `$${usd.toFixed(digits)}`;
  return `$${usd.toFixed(8)}`;
}
/** An amount to the nearest cent, as money says it; one under a cent to the nearest ten-thousandth ($0.0024), so a run's
 *  spend or budget under a cent is never said as $0 while it is more. */
export const centsMoney = (usd: number): string => money(Math.abs(usd) >= 0.01 ? Math.round(usd * 100) / 100 : Math.round(usd * 1e4) / 1e4);
/** A least in words: rounded up to the cent within a float's tail, so that it is enough ($0.1024 is $0.11); one under a
 *  cent rounded up at the fourth place, never past what it needs by more ($0.0024 is $0.0024, never $0.01) and never $0. */
export const leastMoney = (usd: number): string => {
  const cents = Math.ceil(usd * 100 - FIT_TOLERANCE * 100);
  if (usd <= 0) return "$0";
  const tenThousandths = Math.max(1, Math.ceil(usd * 1e4 - FIT_TOLERANCE * 1e4));
  return tenThousandths >= 100 ? `$${(cents / 100).toFixed(2)}` : `$${(tenThousandths / 1e4).toFixed(4)}`;
};
/** The cap to raise to for a step past `cap` that needs `total` in all: whole cents, a cent at least, above the cap. */
export const raiseFigure = (cap: number, total: number): number => {
  const cents = Math.ceil(total * 100 - FIT_TOLERANCE * 100);
  return (cents / 100 > cap + CAP_TOLERANCE ? cents : Math.floor((cap + CAP_TOLERANCE) * 100) + 1) / 100;
};
export const raiseTo = (cap: number, total: number): string => `$${raiseFigure(cap, total).toFixed(2)}`;
/** The raise a run parked at its cap is offered: what was taken plus 10 times the refused step's least, scaled from that
 *  need: rounded up to a whole dollar from a dollar on (a hair under, so a float just past a dollar stays that dollar), and
 *  under a dollar, for a cap under one, to the cent (a $0.0002 cap is offered $0.03, never $1); above the cap past a
 *  float's tail either way. */
export const suggestedRaise = (cap: number, spentUsd: number, needsUsd: number): number => {
  const total = spentUsd + SUGGESTED_RAISE_FACTOR * needsUsd;
  if (total < 1 - 1e-9 && cap < 1) {
    const cents = Math.ceil(total * 100 - 1e-7) / 100;
    return cents > cap + CAP_TOLERANCE ? cents : (Math.floor((cap + CAP_TOLERANCE) * 100) + 1) / 100;
  }
  const up = Math.ceil(total - 1e-9);
  return up > cap + CAP_TOLERANCE ? up : Math.floor(cap + CAP_TOLERANCE) + 1;
};

/** What a run has spent of its cap: and what it holds for steps still running, when that is a cent or more. */
const spentOf = (spent: number, held: number, cap: number): string =>
  Math.round(held * 100) >= 1 ? `spent ${centsMoney(spent)} and holds ${centsMoney(held)} for steps still running, of its ${money(cap)} cap` : `spent ${centsMoney(spent)} of its ${money(cap)} cap`;

/** What a model request's least is for, as a person reads it: its input's bound (counted at a token per byte, the most a
 *  byte-level tokenizer makes of it), what of it the cache reads, and the least answer it keeps. */
export type NeedParts = { readonly inputTokens: number; readonly cachedTokens: number; readonly answerTokens: number };
const count = (tokens: number): string => Math.round(tokens).toLocaleString("en-US");
const partsOf = (parts: NeedParts | undefined): string => {
  if (!parts) return "";
  const said: string[] = [];
  if (parts.inputTokens > 0) said.push(`its input, up to ${count(parts.inputTokens)} tokens counted at a token per byte, ${parts.cachedTokens > 0 ? `${count(parts.cachedTokens)} of them read from the cache` : "none of it read from the cache"}`);
  if (parts.answerTokens > 0) said.push(`an answer of at least ${count(parts.answerTokens)} tokens`);
  return said.length ? ` (${said.join(", and ")})` : "";
};

/** A model request what is left cannot buy the least of; `parts`, what that least is for, said beside it. */
export function roomRefusal(cap: number, spent: number, held: number, least: number, boundUsd?: number, parts?: NeedParts): { text: string; figures: RefusalFigures } {
  const leastCapUsd = raiseFigure(cap, spent + held + least);
  const figures: RefusalFigures = { spentUsd: spent + held, needsUsd: least, leastCapUsd, ...(boundUsd && boundUsd > 0 ? { boundUsd } : {}) };
  const [need, raise] = [`${leastMoney(least)}${partsOf(parts)}`, `$${leastCapUsd.toFixed(2)}`];
  if (spent === 0 && held === 0) return { text: `${CAP_REFUSAL_CODE}Not sent: the next step needs at least ${need}, and this run's cap is ${money(cap)}. Raise the cap to at least ${raise} to continue.`, figures };
  return { text: `${CAP_REFUSAL_CODE}Not sent: this run has ${spentOf(spent, held, cap)}, and the next step needs at least ${need}. Raise the cap to at least ${raise} to continue.`, figures };
}

/** A paid call what is left cannot hold. */
export function paidRefusal(cap: number, spent: number, held: number, name: string, holdUsd: number, basis: string): { text: string; figures: RefusalFigures } {
  const leastCapUsd = raiseFigure(cap, spent + held + holdUsd);
  return {
    text: `${SPEND_CAP_REACHED}: Not sent: this run has ${spentOf(spent, held, cap)}, and the next step, ${name}, could cost up to ${money(holdUsd)} (${basis}). Raise the cap to at least $${leastCapUsd.toFixed(2)} to continue.`,
    figures: { spentUsd: spent + held, needsUsd: holdUsd, leastCapUsd },
  };
}

/** An amount rounded up to the cent, so "at most" holds. */
const centsUp = (usd: number): string => money(Math.ceil(usd * 100 - 1e-9) / 100);

/** The over-cap row's words, after the usage row whose booked cost `spentUsd` passed `capUsd`: by how much; when it passed
 *  by no more than `boundUsd` (the bound of the requests since the cost last fit), a cache miss did it, and the most it
 *  could have. None at or under the cap, with no cap, or with no known cost. */
export function overCapWords(spentUsd: number | null, capUsd: number | undefined, boundUsd = 0): string | undefined {
  if (capUsd === undefined || typeof spentUsd !== "number" || spentUsd <= capUsd + FIT_TOLERANCE) return undefined;
  const byMiss = boundUsd > 0 && spentUsd - capUsd <= boundUsd + FIT_TOLERANCE;
  return byMiss ? `Went ${centsUp(spentUsd - capUsd)} over its cap on a cache miss (at most ${centsUp(boundUsd)}).` : `Spent ${centsMoney(spentUsd)}, ${centsUp(spentUsd - capUsd)} over the run's cap of ${centsMoney(capUsd)}`;
}

export const unmeasured = (cap: number): string => `${SPEND_CAP_REACHED}: Not sent: the size of the next model request's input is unknown, so the run's cap of ${money(cap)} cannot be kept: the run is out of budget.`;
export const noPrice = (cap: number): string => `${SPEND_CAP_REACHED}: Not sent: the next model request's model has no price here, so the run's cap of ${money(cap)} cannot be kept: the run is out of budget.`;
export const noCeiling = (cap: number): string => `${SPEND_CAP_REACHED}: Not sent: the next model request's model has no output ceiling here and its output is priced, so what a request may cost has no bound and the run's cap of ${money(cap)} cannot be kept: the run is out of budget.`;
export const noToolPrice = (cap: number, name: string): string => `${SPEND_CAP_REACHED}: Not sent: the next step, ${name}, has no price here, so the run's cap of ${money(cap)} cannot be kept: the run is out of budget.`;
export const unknownSpend = (cap: number): string => `${SPEND_CAP_REACHED}: Not sent: what the run has spent is unknown, so its cap of ${money(cap)} cannot be kept: the run is out of budget.`;
export const unknownHeld = (cap: number): string => `${SPEND_CAP_REACHED}: Not sent: what the run's steps still running hold is unknown, so its cap of ${money(cap)} cannot be kept: the run is out of budget.`;
