// The kernel cap's one pricing rule, the same for every harness. A request's input bound (its measured bytes, what its
// provider adds, what its hosted tools read) is priced at the dearer of the input and cache-write prices; under "expected"
// the previous request's cache counts at the cache-read price when it ended under CACHE_WARM_MS ago on the same model, so
// only a cache miss can pass the cap, by at most the request's bound; under "strict" every token uncached. Its output is
// held at what it is sent with, its thinking budget included.
import { providerInputOverhead } from "../../host/overhead.js";
import type { CapMode, ModelCapRequest, ModelPrice, Previous } from "./types.js";

/** How long after a request ended the next one in its conversation is expected to read its cache: 4 minutes, inside
 *  Anthropic's 5. */
export const CACHE_WARM_MS = 4 * 60_000;
/** The tokens a limited request keeps for its answer. */
export const ANSWER_TOKENS_LEAST = 1_024;
/** The least thinking budget Anthropic takes. */
export const THINKING_BUDGET_LEAST = 1_024;
/** What a stopped request counts beyond what it streamed: what the provider may have produced after the last word read. */
export const STOP_ALLOWANCE_TOKENS = 1_024;
/** How far past what is left a sum may read and still fit it: a float's own tail, never a spend past the cap. */
export const FIT_TOLERANCE = 1e-12;
/** How near two caps are the same cap: a raise must be above a run's cap by more. */
export const CAP_TOLERANCE = 1e-9;
/** The APIs whose thinking takes a token budget added to the request's own output limit. */
const BUDGET_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "bedrock-converse-stream"]);

/** A request's input as it is priced: `cached` tokens at the cache-read price, `fresh` at the dearer of input and cache write. */
export type InputParts = { cached: number; fresh: number };
/** A price as a function of its input parts and its output tokens, in USD. */
export type Pricing = (input: InputParts, output: number) => number;

/** `price` as the cap prices with it. */
export function pricingOf(price: ModelPrice): Pricing {
  const read = price.cacheRead ?? price.input;
  const fresh = Math.max(price.input, price.cacheWrite ?? price.input);
  return (parts, output) => (parts.cached * read + parts.fresh * fresh + output * price.output) / 1e6;
}

/** The input of a request of `bound` tokens on `model` expected after `previous`, at `now`: its cache read, and its input
 *  after the cache plus what the body grew by at full price. Undefined (all of it uncached) with no previous request, one
 *  on another model, one that ended CACHE_WARM_MS or more ago, or a clock that reads before its end. */
export function expectedInput(bound: number, previous: Previous | undefined, now: number, model: string): InputParts | undefined {
  if (!previous || previous.model !== model) return undefined;
  const gap = now - previous.endedAt;
  if (!(gap >= 0 && gap < CACHE_WARM_MS)) return undefined;
  return { cached: previous.cachedTokens, fresh: previous.inputTokens + Math.max(0, bound - previous.boundTokens) };
}

/** A request priced under `mode`: `cost(output)`, what it is held at (its expected input, never more than uncached), and
 *  `worst(output)`, its input uncached; each with its hosted tools' most fee. */
export function requestPrice(pricing: Pricing, bound: number, previous: Previous | undefined, now: number, mode: CapMode, model: string, feeUsd = 0): { cost(output: number): number; worst(output: number): number } {
  const worst = (output: number) => pricing({ cached: 0, fresh: bound }, output) + feeUsd;
  const parts = mode === "strict" ? undefined : expectedInput(bound, previous, now, model);
  if (!parts) return { cost: worst, worst };
  return { cost: (output) => Math.min(pricing(parts, output) + feeUsd, worst(output)), worst };
}

/** A request's whole input bound: its measured bytes, what its provider adds for what it carries, and what its hosted tools
 *  read. Undefined when its bytes were not measured. */
export function inputBound(request: ModelCapRequest): number | undefined {
  const measured = request.inputTokens;
  if (typeof measured !== "number" || !Number.isFinite(measured) || measured < 0) return undefined;
  const added = request.shape ? providerInputOverhead(request.model.api, request.shape) : 0;
  return measured + added + (request.extraInputTokens ?? 0);
}

/** The output a request is sent with at most: what it asks (its model's ceiling when it says none), and its thinking budget
 *  on an API whose thinking takes one, within the ceiling. Undefined: no ceiling and none asked. */
export function outputAsked(request: ModelCapRequest): number | undefined {
  const ceiling = request.model.outputCeiling ?? undefined;
  const asked = request.outputAsked ?? ceiling;
  if (asked === undefined) return undefined;
  const withThinking = asked + (thinks(request) && BUDGET_APIS.has(request.model.api) ? request.thinkingBudget! : 0);
  return ceiling === undefined ? withThinking : Math.min(withThinking, ceiling);
}

/** The least output a request may be limited to and still answer: what its body says, else the answer's 1,024 tokens and
 *  its thinking's least (the least budget where thinking takes one, else its whole budget, which then shares the limit);
 *  never more than it asks. */
export function outputLeast(request: ModelCapRequest, asked: number): number {
  const least = request.outputTokensLeast ?? ANSWER_TOKENS_LEAST + (thinks(request) ? (BUDGET_APIS.has(request.model.api) ? THINKING_BUDGET_LEAST : request.thinkingBudget!) : 0);
  return Math.min(least, asked);
}

const thinks = (request: ModelCapRequest): boolean => typeof request.thinkingBudget === "number" && request.thinkingBudget > 0;

/** The thinking budget a request limited to `output` keeps: its own, squeezed so the answer keeps its 1,024 tokens. */
export function thinkingWithin(request: ModelCapRequest, output: number): number | undefined {
  if (!thinks(request) || !BUDGET_APIS.has(request.model.api)) return undefined;
  return Math.max(0, Math.min(request.thinkingBudget!, output - ANSWER_TOKENS_LEAST));
}

/** The most output tokens from `least` to `asked` whose request costs no more than `left`; undefined when even `least`
 *  costs more. A search, so a price with tiers is exact. */
export function mostOutput(cost: (output: number) => number, least: number, asked: number, left: number): number | undefined {
  const fits = (tokens: number) => cost(tokens) <= left + FIT_TOLERANCE;
  if (!fits(least)) return undefined;
  if (fits(asked)) return asked;
  let [low, high] = [least, asked];
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return low;
}
