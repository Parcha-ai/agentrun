// Firecrawl on the run's key (https://docs.firecrawl.dev, API v2): /v2/search for web_search, /v2/scrape for web_fetch,
// each one paid request (fees.ts firecrawlFeeOf) through the run's Pay, on a bearer token. Its settings are typed, each
// with a default (FIRECRAWL_DEFAULTS); a setting it does not take is refused when the Web is made. A 401 refuses the key
// for the run; a 403 refuses one request only (Firecrawl answers it for a page, as for a prompt injection it found).
import { firecrawlFeeOf, type Pay } from "../fees.js";
import { clip, markdownRead, type Read, TITLE_CAP } from "../page.js";
import { defineProvider, type ProviderRun, settingsOf } from "../provider.js";
import { type Failed, failed, failure, type Hit, type Limit, retryAfterMs, type SearchAsk, type Searched, searchArgs, snippetOf, waitOf } from "../search.js";
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

/** How many of a search's queries Firecrawl is sent: one request each, at once. */
export const FIRECRAWL_QUERIES_MAX = 3;
/** The scrape a Firecrawl search asks of each result, as Firecrawl's guidance for agents asks: its page as markdown, its
 *  main content alone unless `settings` say otherwise (each a scrape, priced by fees.ts firecrawlFeeOf). */
export const firecrawlScrapeOptions = (settings: FirecrawlSettings = {}) => ({ formats: ["markdown"], onlyMainContent: settings.onlyMainContent ?? FIRECRAWL_DEFAULTS.onlyMainContent });

/** Firecrawl's search rows, an answer's `data` or its `data.web`, as hits: each row whose url parses, its snippet its
 *  page's markdown, else its description; undefined where the answer holds no rows this server reads. */
export function firecrawlHits(data: unknown): Hit[] | undefined {
  const holder = data as { web?: unknown } | unknown[] | undefined;
  const rows = Array.isArray(holder) ? holder : Array.isArray(holder?.web) ? holder.web : undefined;
  if (!rows) return undefined;
  return rows.flatMap((row: { url?: unknown; title?: unknown; description?: unknown; markdown?: unknown } | null): Hit[] => {
    if (typeof row?.url !== "string" || !URL.canParse(row.url)) return [];
    const text = typeof row.markdown === "string" && row.markdown.trim() ? row.markdown : typeof row.description === "string" ? row.description : "";
    return [{ url: row.url, title: typeof row.title === "string" ? clip(row.title, TITLE_CAP) : "", snippet: snippetOf(text) }];
  });
}

/** The queries of `ask` Firecrawl is sent (FIRECRAWL_QUERIES_MAX), and each one's limit: n shared among them, rounded up. */
export const firecrawlQueries = ({ queries, n }: SearchAsk): { queries: string[]; limit: number } => {
  const sent = queries.slice(0, FIRECRAWL_QUERIES_MAX);
  return { queries: sent, limit: Math.ceil(n / Math.max(1, sent.length)) };
};

/** How long `limit`, met at `nowMs`, says to wait: its Retry-After (retryAfterMs), else the breaker's default wait. */
const waitedMs = (limit: Limit, nowMs: number): number => retryAfterMs(limit.retryAfter, nowMs) ?? waitOf(undefined, nowMs);

/** The most binding limit among `failures`: a quota over any rate limit, else the rate limit naming the longest wait
 *  (the first met of those that tie); the failure that met it. The queries go out at once, so every limit is met at
 *  about the same moment, and the breaker must hold the longest any of them named. */
const bindingOf = (failures: readonly Failed[], nowMs: number = Date.now()): Failed | undefined => {
  const quota = failures.find((one) => one.limit?.kind === "quota");
  if (quota) return quota;
  return failures.filter((one) => one.limit).reduce<Failed | undefined>((longest, one) => (longest === undefined || waitedMs(one.limit!, nowMs) > waitedMs(longest.limit!, nowMs) ? one : longest), undefined);
};

/** One search's answer from `each`, its queries' requests in query order, each its hits or its failure: the hits of every
 *  request that answered, deduped by url (the first seen kept, in query order then the provider's), cut at `ask.n`;
 *  with none answered, the first failure in query order. The most binding limit any request met (a quota over a rate
 *  limit, else the longest wait) goes to the run's breaker either way, typed as the failure that met it. */
export function firecrawlMerged(provider: "firecrawl" | "firecrawl-keyless", { objective, queries, n }: SearchAsk, each: readonly (Hit[] | Failed)[]): Searched {
  const failures = each.filter((one): one is Failed => !Array.isArray(one));
  const binding = bindingOf(failures);
  const answered = each.filter((one): one is Hit[] => Array.isArray(one));
  if (!answered.length) {
    const first = failures[0]!;
    // The first failure's words and type; the binding limit, and whether it covers the key, from the one that met it.
    const covers = binding?.failure.covers;
    return { answer: { error: first.error }, failure: { ...first.failure, ...(covers ? { covers } : {}) }, ...(binding ? { limit: binding.limit as Limit } : {}) };
  }
  const held = binding ? { failure: binding.failure, limit: binding.limit as Limit } : {};
  const seen = new Set<string>();
  const results = answered.flat().filter((hit) => !seen.has(hit.url) && Boolean(seen.add(hit.url))).slice(0, n);
  return { answer: { provider, objective, queries, results }, ...held };
}

/** The /v2/search request for `query`, `n` results, under `settings`: each result scraped (firecrawlScrapeOptions). */
export function firecrawlSearchBody(query: string, n: number, settings: FirecrawlSettings = {}): Record<string, unknown> {
  return {
    query,
    limit: n,
    scrapeOptions: firecrawlScrapeOptions(settings),
    ...(settings.tbs ? { tbs: settings.tbs } : {}),
    ...(settings.includeDomains ? { includeDomains: settings.includeDomains } : {}),
    ...(settings.excludeDomains ? { excludeDomains: settings.excludeDomains } : {}),
    ...(settings.country ? { country: settings.country } : {}),
    ...(settings.highlights === undefined ? {} : { highlights: settings.highlights }),
  };
}

/** `{objective, queries?, n?}` (searchArgs) searched through `client` (null: the run holds no key) under `settings`:
 *  up to FIRECRAWL_QUERIES_MAX of its queries, one paid request each, all at once, merged (firecrawlMerged), and the
 *  limit Firecrawl answered for the run's key, if any. */
export async function firecrawlSearched(args: Record<string, unknown>, client: Keyed | null, settings: FirecrawlSettings = {}, signal?: AbortSignal): Promise<Searched> {
  const ask = searchArgs(args);
  if (!ask.objective) return { answer: { error: "web_search needs an objective" } };
  const { queries, limit } = firecrawlQueries(ask);
  const each = await Promise.all(queries.map(async (query): Promise<Hit[] | Failed> => {
    const got = await keyedCall(client, "Firecrawl", "FIRECRAWL_API_KEY", "search", "/v2/search", firecrawlSearchBody(query, limit, settings), signal);
    if ("error" in got) return got;
    return (got.json.success === false ? undefined : firecrawlHits(got.json.data)) ?? failed("error", "UNREADABLE", "Firecrawl's search answered no results this server reads");
  }));
  return firecrawlMerged("firecrawl", ask, each);
}

/** The /v2/scrape request for `url` under `settings`: markdown alone. */
export function firecrawlScrapeBody(url: string, settings: FirecrawlSettings = {}): Record<string, unknown> {
  return { url, formats: ["markdown"], onlyMainContent: settings.onlyMainContent ?? FIRECRAWL_DEFAULTS.onlyMainContent, ...(settings.maxAgeMs === undefined ? {} : { maxAge: settings.maxAgeMs }) };
}

/** A page Firecrawl scraped for `url` (`page`, its scrape's `{markdown, metadata}`, keyed or keyless alike) as a Read:
 *  the url it ended at (metadata's url, else its sourceURL, else `url`), its title (a list's first string), its status.
 *  Firecrawl names no cut, so the text is read as the whole page's; no markdown is no text, and a page whose status is
 *  not 2xx is no read. */
export function firecrawlPageOf(url: string, page: { markdown?: unknown; metadata?: unknown }): Read | Failed {
  if (typeof page.markdown !== "string" || page.markdown.trim() === "") return failed("not_text", "NO_TEXT", "Firecrawl's fetch answered no page text");
  const meta = (typeof page.metadata === "object" && page.metadata !== null ? page.metadata : {}) as { title?: unknown; sourceURL?: unknown; url?: unknown; statusCode?: unknown };
  const final = [meta.url, meta.sourceURL].find((one): one is string => typeof one === "string" && URL.canParse(one)) ?? url;
  const status = typeof meta.statusCode === "number" && Number.isInteger(meta.statusCode) ? meta.statusCode : 200;
  if (status < 200 || status > 299) return failed("error", `PAGE_${status}`, `Firecrawl's fetch: the page answered ${status}`);
  const title = typeof meta.title === "string" ? meta.title : Array.isArray(meta.title) && typeof meta.title[0] === "string" ? meta.title[0] : "";
  return markdownRead(final, title, page.markdown, true, status);
}

/** The page at `url` scraped through `client` under `settings` (firecrawlPageOf), or why there is none. */
export async function firecrawlRead(url: string, client: Keyed | null, settings: FirecrawlSettings = {}, signal?: AbortSignal): Promise<Read | KeyedFailed> {
  const got = await keyedCall(client, "Firecrawl", "FIRECRAWL_API_KEY", "fetch", "/v2/scrape", firecrawlScrapeBody(url, settings), signal);
  if ("error" in got) return got;
  const data = (typeof got.json.data === "object" && got.json.data !== null ? got.json.data : {}) as { markdown?: unknown; metadata?: unknown };
  return firecrawlPageOf(url, got.json.success === false ? {} : data);
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
      unready: () => (!client ? failure("refused", "NO_KEY", "not tried: this run holds no Firecrawl key") : client.live() ? undefined : failure("refused", "KEY_REFUSED", "not tried: refused earlier in this run")),
    };
  },
);
