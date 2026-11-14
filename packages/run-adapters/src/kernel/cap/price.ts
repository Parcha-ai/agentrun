// The kernel cap's one pricing rule, the same for every harness. A request's input bound (its measured bytes, what its
// provider adds, what its hosted tools read) is priced at the dearer of the input and cache-write prices; under "expected"
// the cache of one of the session's recent requests (warmFrom) counts at the cache-read price, so only a cache miss can
// pass the cap, by at most the request's bound; under "strict" every token uncached. Its output is held at what it is
// sent with, its thinking budget included.
import { providerInputOverhead } from "../../host/overhead.js";
import type { CapMode, ModelCapRequest, ModelPrice, PriceRates, RecentRequest } from "./types.js";

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

/** `price` as the cap prices with it: a request's cached input at the cache-read rate, its fresh input at the dearer of
 *  the input and cache-write rates, and its output at the output rate, each at the rates of the tier its whole input
 *  passes (ratesFor). A hold, a worst case and a booking the cap prices are so never under what the provider bills. */
export function pricingOf(price: ModelPrice): Pricing {
  return (parts, output) => {
    const rates = ratesFor(price, parts.cached + parts.fresh);
    const read = rates.cacheRead ?? rates.input;
    const fresh = Math.max(rates.input, rates.cacheWrite ?? rates.input);
    return (parts.cached * read + parts.fresh * fresh + output * rates.output) / 1e6;
  };
}

/** How many of a session's recent requests it keeps (recentAfter), the newest: enough for a conversation's last request
 *  to outlast the smaller requests a CLI sends between two of its own. Fewer only prices a request colder, never under. */
export const RECENT_REQUESTS_KEPT = 16;

/** The recent request whose cache a request of `bound` tokens on `model` is expected to read at `now`: of `recent`, those
 *  on its model that ended under CACHE_WARM_MS ago (by a clock that does not read before their end) with a bound no bigger
 *  than its own (a conversation only grows between its own requests), the biggest, the newest of equal ones. So a smaller
 *  request between two of a conversation's own (a CLI's side request while a tool runs, a child's, a summary) leaves the
 *  conversation's next request warm from its last, and a conversation that compacted is warm again from its first request
 *  after the compaction. None: priced uncached. */
export function warmFrom(bound: number, recent: readonly RecentRequest[] | undefined, now: number, model: string): RecentRequest | undefined {
  let best: RecentRequest | undefined;
  for (const one of recent ?? []) {
    const gap = now - one.endedAt;
    if (one.model !== model || !(gap >= 0 && gap < CACHE_WARM_MS) || !(one.boundTokens <= bound)) continue;
    if (!best || one.boundTokens > best.boundTokens || (one.boundTokens === best.boundTokens && one.endedAt >= best.endedAt)) best = one;
  }
  return best;
}

/** The input of a request of `bound` tokens on `model` expected at `now` after `recent`: the cache of the request warmFrom
 *  picks at the cache-read price, and that request's input after the cache plus what the body grew by since at full
 *  price. Undefined (all of it uncached) when it picks none.
 *
 *  Why a warm price opens no way past the cap. It is a guess: the request picked may be another conversation's whose
 *  bound happened to fit, or its cache may be gone. The guess lowers only what the request is held at (requestPrice's
 *  cost, never above its worst), never its worst: the whole bound uncached at the dearer of the input and cache-write
 *  prices whichever request was picked, the output limited to what it was admitted at. So a request's real cost is at
 *  most its hold plus its bound (Judged.boundUsd): a guess too low adds that much at most, the cache miss "expected" has
 *  always allowed and serve reports as the run's overshoot bound. The bound is counted wherever the run's room is read
 *  while the request is out (the wrap-up's gate and note count it at hold + bound, sessionSpendOf; a claim lost with it
 *  open books it cut at both); a CLI's own request admitted with its host's keep-back is limited so its worst leaves the
 *  keep-back free (rule.ts judgeModel), so even a miss stays under the cap; and once a request answers, its real cost
 *  is booked and the next admission reads it. "strict" reads no cache: every request held at its worst. */
export function expectedInput(bound: number, recent: readonly RecentRequest[] | undefined, now: number, model: string): InputParts | undefined {
  const from = warmFrom(bound, recent, now, model);
  return from && { cached: from.cachedTokens, fresh: from.inputTokens + (bound - from.boundTokens) };
}

/** The session's recent requests once `ended` has answered: `ended`, and those that ended under CACHE_WARM_MS before it
 *  but one on its model, measured its way and of its bound (`ended` is the newer of the two); the newest
 *  RECENT_REQUESTS_KEPT. None is dropped for being smaller or bigger than `ended`: warmFrom picks for each request. */
export function recentAfter(recent: readonly RecentRequest[], ended: RecentRequest): RecentRequest[] {
  const same = (one: RecentRequest) => one.model === ended.model && (one.counted === true) === (ended.counted === true) && one.boundTokens === ended.boundTokens;
  return [...recent.filter((one) => ended.endedAt - one.endedAt < CACHE_WARM_MS && !same(one)), ended].slice(-RECENT_REQUESTS_KEPT);
}

/** A request priced under `mode`: `cost(output)`, what it is held at (its expected input, never more than uncached), and
 *  `worst(output)`, its input uncached; each with its hosted tools' most fee. */
export function requestPrice(pricing: Pricing, bound: number, recent: readonly RecentRequest[] | undefined, now: number, mode: CapMode, model: string, feeUsd = 0): { cost(output: number): number; worst(output: number): number } {
  const worst = (output: number) => pricing({ cached: 0, fresh: bound }, output) + feeUsd;
  const parts = mode === "strict" ? undefined : expectedInput(bound, recent, now, model);
  if (!parts) return { cost: worst, worst };
  return { cost: (output) => Math.min(pricing(parts, output) + feeUsd, worst(output)), worst };
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
