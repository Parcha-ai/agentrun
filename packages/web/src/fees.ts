// Parallel's, Exa's and Firecrawl's prices, the Fee a paid request carries, and Pay, the injected cap a paid request goes
// through. A request the cap refuses is never sent: Pay throws PaidRefused, whose message is the refusal.

/** The modes Parallel's Search API is priced in here; a request in any other mode (or naming none) has no price. */
export type ParallelSearchMode = "turbo" | "fast" | "basic" | "advanced";
/** Parallel's published prices (https://docs.parallel.ai/resources/pricing, read 2026-11-20). Search, by the request's
 *  `mode`: `turbo` or `fast` $1 per 1,000 requests, `basic` or `advanced` $5 per 1,000, each with 10 results included,
 *  and each result past those 10 $1 per 1,000. Extract: $1 per 1,000 URLs. */
export const PARALLEL_SEARCH_MODE_USD: Readonly<Record<ParallelSearchMode, number>> = Object.freeze({ turbo: 0.001, fast: 0.001, basic: 0.005, advanced: 0.005 });
/** A `fast` search's price, the mode the web tools search in by default (parallel.ts PARALLEL_DEFAULTS). */
export const PARALLEL_SEARCH_USD: number = PARALLEL_SEARCH_MODE_USD.fast;
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
 *  Credits past the plan cost $5 per 2,000 ($0.0025). Firecrawl's credit rule (https://docs.firecrawl.dev/billing, read
 *  2026-11-28): a search is "2 credits / 10 results", "Rounded up per 10 results", and "Additional per-page scrape costs
 *  apply to each result that is scraped"; a scrape is "1 credit / page", a PDF "+1 credit / PDF page", JSON "+4 credits /
 *  page"; "Firecrawl returned no document: 0 credits". Measured on 2026-11-28 (17 calls, creditsUsed equal to the
 *  account's counter each time): a PDF is 1 credit a page parsed, not 1 more than its pages, and a result with no
 *  document is 0. */
export const FIRECRAWL_CREDIT_USD = 0.00099;
export const FIRECRAWL_SEARCH_CREDITS = 2;
export const FIRECRAWL_SCRAPE_CREDITS = 1;
export const FIRECRAWL_JSON_CREDITS = 4;
/** The most pages Firecrawl parses of one PDF (its parsers' maxPages bound): a body that caps none is held at it. */
export const FIRECRAWL_PDF_PAGES_MAX = 10_000;

/** Whether a scrape's `formats` asks for JSON (a string or an object of that type). */
const asksJson = (formats: unknown): boolean => Array.isArray(formats) && formats.some((format) => format === "json" || (typeof format === "object" && format !== null && (format as { type?: unknown }).type === "json"));
/** The most pages `parsers` lets Firecrawl parse of a PDF: its pdf parser's maxPages, else Firecrawl's own most. */
const pdfPagesOf = (parsers: unknown): number => {
  const pdf = Array.isArray(parsers) ? parsers.find((one) => typeof one === "object" && one !== null && (one as { type?: unknown }).type === "pdf") : undefined;
  const pages = (pdf as { maxPages?: unknown } | undefined)?.maxPages;
  return typeof pages === "number" && Number.isInteger(pages) && pages >= 1 ? Math.min(pages, FIRECRAWL_PDF_PAGES_MAX) : FIRECRAWL_PDF_PAGES_MAX;
};
/** The most credits one document scraped under `options` may cost (an HTML page 1, a PDF 1 a page up to its cap, JSON
 *  4 more), or undefined when it asks a proxy other than basic: an escalated proxy is priced nowhere here, so a body
 *  asking one (or leaving it to Firecrawl's own "auto") is never sent. */
const documentCredits = (options: { formats?: unknown; parsers?: unknown; proxy?: unknown }): number | undefined =>
  options.proxy !== "basic" ? undefined : Math.max(FIRECRAWL_SCRAPE_CREDITS, pdfPagesOf(options.parsers)) + (asksJson(options.formats) ? FIRECRAWL_JSON_CREDITS : 0);

/** The fee of a request to Firecrawl's `path` with `body`, its hold: the most it may cost under the body's caps. A search
 *  is 2 credits per 10 of its limit (10 by default), rounded up, and, when it scrapes its results, each result at the
 *  most one scraped document may cost (documentCredits); a scrape is one document's most. What it is charged is the
 *  credits Firecrawl reports, never above this (firecrawlChargeOf). Undefined for an endpoint the web tools do not ask,
 *  and for a body asking a proxy other than basic (a search for its results, a scrape for its page). */
export function firecrawlFeeOf(path: string, body: unknown): Fee | undefined {
  const asked = (body ?? {}) as { limit?: unknown; scrapeOptions?: { formats?: unknown; parsers?: unknown; proxy?: unknown }; formats?: unknown; parsers?: unknown; proxy?: unknown };
  const fee = (name: string, credits: number, basis: string): Fee => ({ name, by: "firecrawl", usd: usd(FIRECRAWL_CREDIT_USD * credits), basis: `${basis}: ${credits} credit${credits === 1 ? "" : "s"} at the key's plan price` });
  if (path === "/v2/search") {
    const n = typeof asked.limit === "number" && asked.limit > 0 ? Math.floor(asked.limit) : 10;
    const each = asked.scrapeOptions ? documentCredits(asked.scrapeOptions) : 0;
    if (each === undefined) return undefined;
    return fee("Firecrawl's search", FIRECRAWL_SEARCH_CREDITS * Math.ceil(n / 10) + n * each, `Firecrawl's most for a search of ${n} results${each ? `, each scraped at up to ${each} credit${each === 1 ? "" : "s"}` : ""}`);
  }
  if (path === "/v2/scrape") {
    const most = documentCredits(asked);
    return most === undefined ? undefined : fee("Firecrawl's scrape", most, "Firecrawl's most for a scrape");
  }
  return undefined;
}

/** The credits Firecrawl reports a 2xx answer to `path` cost (`json`, its parsed body; undefined when it was not JSON):
 *  a search's top-level creditsUsed, a scrape's data.metadata.creditsUsed; undefined unless a whole number, 0 or more. */
export function firecrawlCreditsOf(path: string, json: unknown): number | undefined {
  const said = path === "/v2/search" ? (json as { creditsUsed?: unknown } | undefined)?.creditsUsed : (json as { data?: { metadata?: { creditsUsed?: unknown } } } | undefined)?.data?.metadata?.creditsUsed;
  return typeof said === "number" && Number.isInteger(said) && said >= 0 ? said : undefined;
}

/** What a 2xx answer to `path` held at `fee` is charged, and the receipt's line for it: the credits Firecrawl reports at
 *  the plan price; the hold when it reports more (saying how many), or none it can be read by (saying so). */
export function firecrawlChargeOf(fee: Fee, path: string, json: unknown): { usd: number; basis: string } {
  const hold = Math.round(fee.usd / FIRECRAWL_CREDIT_USD);
  const plural = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;
  const reported = firecrawlCreditsOf(path, json);
  if (reported === undefined) return { usd: fee.usd, basis: `the hold, ${plural(hold)}; Firecrawl reported no credit count` };
  const charged = usd(FIRECRAWL_CREDIT_USD * reported);
  if (charged > fee.usd) return { usd: fee.usd, basis: `the hold, ${plural(hold)}; Firecrawl reported ${plural(reported)}` };
  return { usd: charged, basis: `Firecrawl reported ${plural(reported)} (hold ${plural(hold)}), at the key's plan price` };
}

/** The words a Pay's `charged` carries for the receipt's line (chargedSaying): what a request was charged, and why. */
const chargedWords = new WeakMap<() => number, () => string | undefined>();
/** `charged`, carrying `said`, the receipt's words for its charge (undefined until there is one). */
export const chargedSaying = (charged: () => number, said: () => string | undefined): (() => number) => {
  chargedWords.set(charged, said);
  return charged;
};
/** The receipt's words `charged` carries (chargedSaying), if any. */
export const chargedSaid = (charged: (() => number) | undefined): string | undefined => (charged ? chargedWords.get(charged)?.() : undefined);

/** A paid request that was not sent: the run's cap refused it, or it has no price here. Its message says why, in the
 *  cap's words. */
export class PaidRefused extends Error {
  override readonly name = "PaidRefused";
}

/** How a paid request is sent: `send` once the run's cap admits `fee`, or a throw of PaidRefused when it does not.
 *  `charged`, from a caller that learns what the request cost once it is answered (decisionPay: the cost a decision's
 *  provider reported), is what the cap settles a billed answer at, never above `fee.usd`; without it, the cap settles
 *  at `fee.usd`. `settled`, from a caller whose line must say what the cap booked (decisionPay), is told whether the
 *  settle of an answered request was written (true) or failed, its hold standing (false); a Pay with no cap never
 *  calls it. */
export type Pay = (fee: Fee, send: () => Promise<Response>, charged?: () => number, settled?: (booked: boolean) => void) => Promise<Response>;
/** No cap: the request is sent as it is. */
export const unmetered: Pay = (_fee, send) => send();

/** What a paid request's send gives its Pay when the request never left this process (keyed.ts paidSend): a 400, which
 *  a cap settles at $0 (a 4xx is booked at nothing), marked with why, so the receipt's line for it says so (unsentOf). */
const unsentAnswers = new WeakMap<Response, string>();
export const unsentAnswer = (why: string): Response => {
  const answer = new Response(null, { status: 400 });
  unsentAnswers.set(answer, why);
  return answer;
};
/** Why `answer` stands for a request that never left (unsentAnswer); undefined for any answer a provider gave. */
export const unsentOf = (answer: Response): string | undefined => unsentAnswers.get(answer);
