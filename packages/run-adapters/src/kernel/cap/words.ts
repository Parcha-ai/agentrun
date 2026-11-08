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
/** An amount to the nearest cent, as money says it. */
export const centsMoney = (usd: number): string => money(Math.round(usd * 100) / 100);
/** A least in words: rounded up to the cent within a float's tail, so that it is enough ($0.1024 is $0.11). */
export const leastMoney = (usd: number): string => `$${(Math.ceil(usd * 100 - FIT_TOLERANCE * 100) / 100).toFixed(2)}`;
/** The cap to raise to for a step past `cap` that needs `total` in all: whole cents, a cent at least, above the cap. */
export const raiseFigure = (cap: number, total: number): number => {
  const cents = Math.ceil(total * 100 - FIT_TOLERANCE * 100);
  return (cents / 100 > cap + CAP_TOLERANCE ? cents : Math.floor((cap + CAP_TOLERANCE) * 100) + 1) / 100;
};
export const raiseTo = (cap: number, total: number): string => `$${raiseFigure(cap, total).toFixed(2)}`;
/** The raise a run parked at its cap is offered: what was taken plus 10 times the refused step's least, rounded up to a
 *  whole dollar (a hair under, so a float just past a dollar stays that dollar), and above the cap past a float's tail. */
export const suggestedRaise = (cap: number, spentUsd: number, needsUsd: number): number => {
  const up = Math.ceil(spentUsd + SUGGESTED_RAISE_FACTOR * needsUsd - 1e-9);
  return up > cap + CAP_TOLERANCE ? up : Math.floor(cap + CAP_TOLERANCE) + 1;
};

/** What a run has spent of its cap: and what it holds for steps still running, when that is a cent or more. */
const spentOf = (spent: number, held: number, cap: number): string => {
  const holds = centsMoney(held);
  return holds !== "$0" ? `spent ${centsMoney(spent)} and holds ${holds} for steps still running, of its ${money(cap)} cap` : `spent ${centsMoney(spent)} of its ${money(cap)} cap`;
};

/** A model request what is left cannot buy the least of. */
export function roomRefusal(cap: number, spent: number, held: number, least: number, boundUsd?: number): { text: string; figures: RefusalFigures } {
  const leastCapUsd = raiseFigure(cap, spent + held + least);
  const figures: RefusalFigures = { spentUsd: spent + held, needsUsd: least, leastCapUsd, ...(boundUsd && boundUsd > 0 ? { boundUsd } : {}) };
  const [need, raise] = [leastMoney(least), `$${leastCapUsd.toFixed(2)}`];
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
export const unknownSpend = (cap: number): string => `${SPEND_CAP_REACHED}: Not sent: what the run has spent is unknown, so its cap of ${money(cap)} cannot be kept: the run is out of budget.`;
