// The kernel cap's one pricing rule, the same for every harness: a request at its worst case. Its input bound (its
// measured bytes, what its provider adds, what its hosted tools read) is priced uncached, every token at the dearer of the
// input and cache-write prices, so a cache miss costs no more than it was held at; its output at what it is sent with,
// its thinking budget included. No request can pass the cap.
import { providerInputOverhead } from "../../host/overhead.js";
import type { ModelCapRequest, ModelPrice, PriceRates } from "./types.js";

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

/** A price as a function of its input tokens (all uncached) and its output tokens, in USD. */
export type Pricing = (inputTokens: number, output: number) => number;

/** The rates of `price` for a request of `inputTokens` in all (fresh and cached): its tier with the highest threshold
 *  that input is above, else its base rates. pi-ai's calculateCost picks them so, on the same table (the catalog's), and
 *  then prices the whole request at them; serve's kernel-cap-tiers-parity test holds the two together. */
export function ratesFor(price: ModelPrice, inputTokens: number): PriceRates {
  let rates: PriceRates = price;
  let threshold = -1;
  for (const tier of price.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rates = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  return rates;
}

/** `price` as the cap prices with it: every input token uncached, at the dearer of the input and cache-write rates (a
 *  cache read is cheaper and a cache write is the dearest an input token bills at), and its output at the output rate,
 *  each at the rates of the tier its whole input passes (ratesFor). A hold the cap prices is so never under what the
 *  provider bills for the same tokens, whatever the cache did. */
export function pricingOf(price: ModelPrice): Pricing {
  return (inputTokens, output) => {
    const rates = ratesFor(price, inputTokens);
    const fresh = Math.max(rates.input, rates.cacheWrite ?? rates.input);
    return (inputTokens * fresh + output * rates.output) / 1e6;
  };
}

/** A request of `bound` input tokens at its worst case: what it costs at `output` tokens, its hosted tools' most fee
 *  included. It is held at this, so it is booked at no more, answered, missed or cut. */
export function requestPrice(pricing: Pricing, bound: number, feeUsd = 0): (output: number) => number {
  return (output) => pricing(bound, output) + feeUsd;
}

/** A request's whole input bound: its measured bytes, what its provider adds for what it carries, and what its hosted tools
 *  read. Undefined when its bytes were not measured. */
export function inputBound(request: ModelCapRequest): number | undefined {
  const measured = request.inputTokens;
  if (typeof measured !== "number" || !Number.isFinite(measured) || measured < 0) return undefined;
  // Below 0 only by images' data counted at their billed size instead; a shape that says more such bytes than were
  // measured is no bound.
  const added = request.shape ? providerInputOverhead(request.model.api, { model: request.model.id, ...request.shape }) : 0;
  const bound = measured + added + (request.extraInputTokens ?? 0);
  return bound < 0 ? undefined : bound;
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
