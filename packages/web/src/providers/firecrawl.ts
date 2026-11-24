// Firecrawl on the run's key (https://docs.firecrawl.dev, API v2): /v2/search for web_search, /v2/scrape for web_fetch,
// each one paid request (fees.ts firecrawlFeeOf) through the run's Pay, on a bearer token. Its settings are typed, each
// with a default (FIRECRAWL_DEFAULTS); a setting it does not take is refused when the Web is made. A 401 refuses the key
// for the run; a 403 refuses one request only (Firecrawl answers it for a page, as for a prompt injection it found).
import { firecrawlFeeOf, type Pay } from "../fees.js";
import { clip, markdownRead, type Read, TITLE_CAP } from "../page.js";
import { defineProvider, type ProviderRun, settingsOf } from "../provider.js";
import { failed, failure, type Hit, type Searched, searchArgs, searchFailed, snippetOf } from "../search.js";
import { type Check, domains, type Keyed, keyedCall, keyedClient, type KeyedFailed, matching, settingsProblems, wholeIn, yesNo } from "./keyed.js";

export const FIRECRAWL_API_URL = "https://api.firecrawl.dev";
/** Firecrawl's bound on one request: its own default timeout for a scrape. */
export const FIRECRAWL_KEYED_MS = 60_000;

/** How Firecrawl searches and reads, each setting optional (FIRECRAWL_DEFAULTS):
 *  - `onlyMainContent`: a scrape leaves out a page's headers, navigation and footers, default true;
 *  - `maxAgeMs`: the oldest cached page a scrape may answer from, 0 a fresh scrape; unset, Firecrawl's own (2 days);
 *  - `tbs`: a search's time filter in Firecrawl's words ("qdr:d" the past day, "qdr:w" the past week, ...); unset, none;
 *  - `includeDomains` or `excludeDomains` (not both): the hostnames a search keeps to or leaves out;
 *  - `country`: the country a search is made from, ISO 3166-1 alpha-2; unset, Firecrawl's own (US);
 *  - `highlights`: each result's description is its query-relevant highlight; unset, Firecrawl's own (true). */
export type FirecrawlSettings = {
  onlyMainContent?: boolean;
  maxAgeMs?: number;
  tbs?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  country?: string;
  highlights?: boolean;
};
export const FIRECRAWL_DEFAULTS = Object.freeze({ onlyMainContent: true } as const);

const FIRECRAWL_CHECKS: Readonly<Record<keyof FirecrawlSettings, Check>> = {
  onlyMainContent: yesNo,
  maxAgeMs: wholeIn(0, 31_536_000_000),
  tbs: matching(/^[a-z_]+:[^\s]{1,120}$/, 'Firecrawl\'s time filter, such as "qdr:w"'),
  includeDomains: domains(100),
  excludeDomains: domains(100),
  country: matching(/^[A-Z]{2}$/, "a two-letter country code, such as \"US\""),
  highlights: yesNo,
};
export function firecrawlSettingsProblems(settings: unknown): string[] {
  const problems = settingsProblems("Firecrawl", settings, FIRECRAWL_CHECKS);
  const asked = settings as FirecrawlSettings;
  if (!problems.length && asked.includeDomains && asked.excludeDomains) problems.push("Firecrawl takes includeDomains or excludeDomains, not both");
  return problems;
}

/** Firecrawl on `apiKey`, each request paid through `pay`. */
export const firecrawlClient = (apiKey: string, send: typeof fetch = fetch, pay?: Pay, base: string = FIRECRAWL_API_URL): Keyed => keyedClient({ who: "Firecrawl", base, headers: { authorization: `Bearer ${apiKey}` }, feeOf: firecrawlFeeOf, timeoutMs: FIRECRAWL_KEYED_MS, refuseOn: [401] }, send, pay);

/** The /v2/search request for `query`, `n` results, under `settings`: the results' descriptions alone, never a scrape. */
export function firecrawlSearchBody(query: string, n: number, settings: FirecrawlSettings = {}): Record<string, unknown> {
  return {
    query,
    limit: n,
    ...(settings.tbs ? { tbs: settings.tbs } : {}),
    ...(settings.includeDomains ? { includeDomains: settings.includeDomains } : {}),
    ...(settings.excludeDomains ? { excludeDomains: settings.excludeDomains } : {}),
    ...(settings.country ? { country: settings.country } : {}),
    ...(settings.highlights === undefined ? {} : { highlights: settings.highlights }),
  };
}

/** `{query, n?}` searched through `client` (null: the run holds no key) under `settings`, and the limit Firecrawl
 *  answered for the run's key, if any. */
export async function firecrawlSearched(args: Record<string, unknown>, client: Keyed | null, settings: FirecrawlSettings = {}, signal?: AbortSignal): Promise<Searched> {
  const { query, n } = searchArgs(args);
  if (!query) return { answer: { error: "web_search needs a query" } };
  const got = await keyedCall(client, "Firecrawl", "FIRECRAWL_API_KEY", "search", "/v2/search", firecrawlSearchBody(query, n, settings), signal);
  if ("error" in got) return searchFailed(got);
  const data = got.json.data as { web?: unknown } | unknown[] | undefined;
  const rows = got.json.success === false ? undefined : Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : undefined;
  if (!rows) return searchFailed(failed("error", "UNREADABLE", "Firecrawl's search answered no results this server reads"));
  const hits = rows.flatMap((row: { url?: unknown; title?: unknown; description?: unknown } | null): Hit[] => (typeof row?.url === "string" && URL.canParse(row.url) ? [{ url: row.url, title: typeof row.title === "string" ? clip(row.title, TITLE_CAP) : "", snippet: snippetOf(typeof row.description === "string" ? row.description : "") }] : []));
  return { answer: { provider: "firecrawl", query, results: hits.slice(0, n) } };
}

/** The /v2/scrape request for `url` under `settings`: markdown alone. */
export function firecrawlScrapeBody(url: string, settings: FirecrawlSettings = {}): Record<string, unknown> {
  return { url, formats: ["markdown"], onlyMainContent: settings.onlyMainContent ?? FIRECRAWL_DEFAULTS.onlyMainContent, ...(settings.maxAgeMs === undefined ? {} : { maxAge: settings.maxAgeMs }) };
}

/** The page at `url` scraped through `client` under `settings`: the page, or why there is none. Firecrawl names no cut,
 *  so the text is read as the whole page's; a page whose status is not 2xx is no read. */
export async function firecrawlRead(url: string, client: Keyed | null, settings: FirecrawlSettings = {}, signal?: AbortSignal): Promise<Read | KeyedFailed> {
  const got = await keyedCall(client, "Firecrawl", "FIRECRAWL_API_KEY", "fetch", "/v2/scrape", firecrawlScrapeBody(url, settings), signal);
  if ("error" in got) return got;
  const data = (typeof got.json.data === "object" && got.json.data !== null ? got.json.data : {}) as { markdown?: unknown; metadata?: unknown };
  if (got.json.success === false || typeof data.markdown !== "string" || data.markdown.trim() === "") return failed("not_text", "NO_TEXT", "Firecrawl's fetch answered no page text");
  const meta = (typeof data.metadata === "object" && data.metadata !== null ? data.metadata : {}) as { title?: unknown; sourceURL?: unknown; url?: unknown; statusCode?: unknown };
  const final = [meta.url, meta.sourceURL].find((one): one is string => typeof one === "string" && URL.canParse(one)) ?? url;
  const status = typeof meta.statusCode === "number" && Number.isInteger(meta.statusCode) ? meta.statusCode : 200;
  if (status < 200 || status > 299) return failed("error", `PAGE_${status}`, `Firecrawl's fetch: the page answered ${status}`);
  const title = typeof meta.title === "string" ? meta.title : Array.isArray(meta.title) && typeof meta.title[0] === "string" ? meta.title[0] : "";
  return markdownRead(final, title, data.markdown, true, status);
}

/** Firecrawl on the run's key, both tools on one client, as keyed Exa is. */
export const firecrawl = defineProvider(
  { id: "firecrawl", label: "Firecrawl", key: { env: "FIRECRAWL_API_KEY" }, ops: ["search", "fetch"], fetch: { miss: { log: "web_fetch_provider_failed", when: "failed" } }, settings: settingsOf<FirecrawlSettings>(firecrawlSettingsProblems) },
  ({ key, send, pay, endpoint, settings }): ProviderRun => {
    const asked = (settings ?? {}) as FirecrawlSettings;
    const client = key === undefined ? null : firecrawlClient(key, send ?? fetch, pay, endpoint ?? FIRECRAWL_API_URL);
    return {
      search: (ask, _deadline, signal) => firecrawlSearched(ask, client, asked, signal),
      read: (url, { signal }) => firecrawlRead(url as string, client, asked, signal),
      unready: () => (client && !client.live() ? failure("refused", "KEY_REFUSED", "not tried: refused earlier in this run") : undefined),
    };
  },
);
