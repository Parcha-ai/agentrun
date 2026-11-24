// Parallel's prices, the Fee a paid request carries, and Pay, the injected cap a paid request goes through. A request
// the cap refuses is never sent: Pay throws PaidRefused, whose message is the refusal.

/** The modes Parallel's Search API is priced in here; a request in any other mode (or naming none) has no price. */
export type ParallelSearchMode = "turbo" | "fast" | "basic" | "advanced";
/** Parallel's published prices (https://docs.parallel.ai/resources/pricing, read 2026-11-20). Search, by the request's
 *  `mode`: `turbo` or `fast` $1 per 1,000 requests, `basic` or `advanced` $5 per 1,000, each with 10 results included,
 *  and each result past those 10 $1 per 1,000. Extract: $1 per 1,000 URLs. */
export const PARALLEL_SEARCH_MODE_USD: Readonly<Record<ParallelSearchMode, number>> = Object.freeze({ turbo: 0.001, fast: 0.001, basic: 0.005, advanced: 0.005 });
/** A `fast` search's price: the mode the web tools search in (web-search.ts). */
export const PARALLEL_SEARCH_USD = 0.001;
export const PARALLEL_SEARCH_RESULT_USD = 0.001;
export const PARALLEL_SEARCH_INCLUDED = 10;
export const PARALLEL_EXTRACT_USD = 0.001;

/** One paid request: `name` in the cap's refusal, `tool` and `by` on its records, `usd` its price, `basis` why. */
export type Fee = { name: string; by: string; usd: number; basis: string };

/** In whole millionths of a dollar, so a sum of prices is the price. */
const usd = (dollars: number) => Math.round(dollars * 1e6) / 1e6;

const isSearchMode = (mode: unknown): mode is ParallelSearchMode => typeof mode === "string" && Object.hasOwn(PARALLEL_SEARCH_MODE_USD, mode);

/** A search in `mode` for `n` results: the mode's price (PARALLEL_SEARCH_MODE_USD), and $0.001 for each past the 10 it
 *  includes. The web tools search `fast`: $0.001. */
export const parallelSearchFee = (n: number, mode: ParallelSearchMode = "fast"): Fee => {
  const more = Math.max(0, n - PARALLEL_SEARCH_INCLUDED);
  return { name: "Parallel's search", by: "parallel", usd: usd(PARALLEL_SEARCH_MODE_USD[mode] + PARALLEL_SEARCH_RESULT_USD * more), basis: more ? `Parallel's list price for a ${mode} search of ${n} results` : `Parallel's list price for a ${mode} search` };
};
/** An extract of `urls` URLs (the web tools ask one at a time). */
export const parallelExtractFee = (urls = 1): Fee => ({ name: "Parallel's extract", by: "parallel", usd: usd(PARALLEL_EXTRACT_USD * urls), basis: urls === 1 ? "Parallel's list price for one URL" : `Parallel's list price for ${urls} URLs` });

/** The fee of a request to Parallel's `url` with `body`: its search's, by its `mode` and the results it asks for (10 by
 *  default), or its extract's, by the URLs; undefined for an endpoint the web tools do not ask, and for a search whose
 *  mode has no price here (one naming none, or one Parallel added since): never $0, never another mode's price. */
export function parallelFeeOf(url: string, body: unknown): Fee | undefined {
  const path = URL.parse(url)?.pathname;
  const asked = (body ?? {}) as { mode?: unknown; advanced_settings?: { max_results?: unknown }; urls?: unknown };
  if (path === "/v1/search") return isSearchMode(asked.mode) ? parallelSearchFee(typeof asked.advanced_settings?.max_results === "number" ? asked.advanced_settings.max_results : PARALLEL_SEARCH_INCLUDED, asked.mode) : undefined;
  if (path === "/v1/extract") return parallelExtractFee(Array.isArray(asked.urls) ? Math.max(1, asked.urls.length) : 1);
  return undefined;
}

/** A paid request that was not sent: the run's cap refused it, or it has no price here. Its message says why, in the
 *  cap's words. */
export class PaidRefused extends Error {
  override readonly name = "PaidRefused";
}

/** How a paid request is sent: `send` once the run's cap admits `fee`, or a throw of PaidRefused when it does not. */
export type Pay = (fee: Fee, send: () => Promise<Response>) => Promise<Response>;
/** No cap: the request is sent as it is. */
export const unmetered: Pay = (_fee, send) => send();
