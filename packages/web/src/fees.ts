// Parallel's, Exa's and Firecrawl's prices, the Fee a paid request carries, and Pay, the injected cap a paid request goes
// through. A request the cap refuses is never sent: Pay throws PaidRefused, whose message is the refusal.

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

/** Exa's search types priced here (https://exa.ai/pricing, read 2026-11-24): per request, 10 results included. A search
 *  in a type with no price here is never sent. */
export type ExaSearchType = "lite" | "instant" | "auto" | "fast" | "deep-lite" | "deep" | "deep-reasoning";
export const EXA_SEARCH_TYPE_USD: Readonly<Record<ExaSearchType, number>> = Object.freeze({ lite: 0.004, instant: 0.004, auto: 0.007, fast: 0.007, "deep-lite": 0.012, deep: 0.012, "deep-reasoning": 0.015 });
/** Each search result past the 10 a type includes: $1 per 1,000. */
export const EXA_SEARCH_RESULT_USD = 0.001;
export const EXA_SEARCH_INCLUDED = 10;
/** Each content asked of a page in a contents request (text, highlights, summary): $1 per 1,000 pages, so a page with
 *  text and highlights is two. A search's text and highlights are in its type's price (Exa's own cost report,
 *  costDollars, 2026-11-24); its AI page summaries are $1 per 1,000 pages. */
export const EXA_CONTENT_USD = 0.001;
export const EXA_SUMMARY_USD = 0.001;
const EXA_CONTENTS = ["text", "highlights", "summary"] as const;

const isExaType = (type: unknown): type is ExaSearchType => typeof type === "string" && Object.hasOwn(EXA_SEARCH_TYPE_USD, type);
/** How many of Exa's priced contents `contents` asks for: each one given and not false. */
const exaContentsAsked = (contents: unknown): number => (typeof contents === "object" && contents !== null ? EXA_CONTENTS.filter((name) => { const asked = (contents as Record<string, unknown>)[name]; return asked !== undefined && asked !== null && asked !== false; }).length : 0);

/** The fee of a request to Exa's `path` with `body`: a search's by its type (auto when it names none, as Exa reads it), its
 *  results past 10 and a summary of each where it asks one; a contents request's by its URLs and the contents asked of each (one
 *  at least: Exa answers text when none is asked). Undefined for an endpoint the web tools do not ask, and for a search
 *  type with no price here. */
export function exaFeeOf(path: string, body: unknown): Fee | undefined {
  const asked = (body ?? {}) as { type?: unknown; numResults?: unknown; contents?: unknown; urls?: unknown };
  if (path === "/search") {
    const type = asked.type ?? "auto";
    if (!isExaType(type)) return undefined;
    const n = typeof asked.numResults === "number" && asked.numResults > 0 ? Math.floor(asked.numResults) : EXA_SEARCH_INCLUDED;
    const summary = (asked.contents as { summary?: unknown } | undefined)?.summary;
    const summaries = summary !== undefined && summary !== null && summary !== false ? n : 0;
    const more = Math.max(0, n - EXA_SEARCH_INCLUDED);
    return { name: "Exa's search", by: "exa", usd: usd(EXA_SEARCH_TYPE_USD[type] + EXA_SEARCH_RESULT_USD * more + EXA_SUMMARY_USD * summaries), basis: `Exa's list price for a ${type} search of ${n} results${summaries ? ", each summarized" : ""}` };
  }
  if (path === "/contents") {
    const urls = Array.isArray(asked.urls) ? Math.max(1, asked.urls.length) : 1;
    const contents = Math.max(1, exaContentsAsked(asked));
    return { name: "Exa's contents", by: "exa", usd: usd(EXA_CONTENT_USD * contents * urls), basis: urls === 1 && contents === 1 ? "Exa's list price for one page's text" : `Exa's list price for ${contents} contents of ${urls} pages` };
  }
  return undefined;
}

/** Firecrawl's price of a credit at the key's plan: Standard, $99 a month for 100,000 credits
 *  (https://www.firecrawl.dev/pricing, read 2026-11-24; the plan's credits read from /v2/team/credit-usage that day).
 *  Credits past the plan cost $5 per 2,000 ($0.0025). A search is 2 credits per 10 results, and a credit for each result
 *  it scrapes; a scrape is 1 credit, and 4 more for the JSON format. */
export const FIRECRAWL_CREDIT_USD = 0.00099;
export const FIRECRAWL_SEARCH_CREDITS = 2;
export const FIRECRAWL_SCRAPE_CREDITS = 1;
export const FIRECRAWL_JSON_CREDITS = 4;

/** Whether a scrape's `formats` asks for JSON (a string or an object of that type). */
const asksJson = (formats: unknown): boolean => Array.isArray(formats) && formats.some((format) => format === "json" || (typeof format === "object" && format !== null && (format as { type?: unknown }).type === "json"));

/** The fee of a request to Firecrawl's `path` with `body`: a search's by its limit (10 by default) and whether it scrapes
 *  its results, a scrape's by whether it asks for JSON. Undefined for an endpoint the web tools do not ask. */
export function firecrawlFeeOf(path: string, body: unknown): Fee | undefined {
  const asked = (body ?? {}) as { limit?: unknown; scrapeOptions?: { formats?: unknown }; formats?: unknown };
  const fee = (name: string, credits: number, basis: string): Fee => ({ name, by: "firecrawl", usd: usd(FIRECRAWL_CREDIT_USD * credits), basis: `${basis}: ${credits} credit${credits === 1 ? "" : "s"} at the key's plan price` });
  if (path === "/v2/search") {
    const n = typeof asked.limit === "number" && asked.limit > 0 ? Math.floor(asked.limit) : 10;
    const scraped = asked.scrapeOptions ? n * (FIRECRAWL_SCRAPE_CREDITS + (asksJson(asked.scrapeOptions.formats) ? FIRECRAWL_JSON_CREDITS : 0)) : 0;
    return fee("Firecrawl's search", FIRECRAWL_SEARCH_CREDITS * Math.ceil(n / 10) + scraped, `Firecrawl's list price for a search of ${n} results${scraped ? ", each scraped" : ""}`);
  }
  if (path === "/v2/scrape") return fee("Firecrawl's scrape", FIRECRAWL_SCRAPE_CREDITS + (asksJson(asked.formats) ? FIRECRAWL_JSON_CREDITS : 0), "Firecrawl's list price for a scrape");
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
