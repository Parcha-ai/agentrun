// Parallel on the run's key: Extract for web_fetch, Search for web_search. Every request is paid through the injected
// Pay at its endpoint's price, and a 401 or 403 stops both for the client's life. Nothing is retried; each ends at 60 s.
import { type ParallelSearchMode, PARALLEL_SEARCH_MODE_USD, type Pay, PaidRefused, parallelFeeOf, unmetered } from "../fees.js";
import { clip, cutAt, markdownRead, PAGE_READ_MAX_CHARS, type Read, TITLE_CAP } from "../page.js";
import { type Failed, failed, failure, type Hit, keyWide, type Search, type SearchAsk, type Searched, searchArgs, searchFailed, snippetOf } from "../search.js";
import { defineProvider, type ProviderRun, settingsOf, type WebClient } from "../provider.js";
import { type Check, domains, keyedClient, matching, oneOf, settingsProblems, statusLimit, thrownFailure, wholeIn } from "./keyed.js";

/** Parallel's API: every request the web tools send goes below it. */
const PARALLEL_API_URL = "https://api.parallel.ai";
export const PARALLEL_SEARCH_URL = `${PARALLEL_API_URL}/v1/search`;
export const PARALLEL_EXTRACT_URL = `${PARALLEL_API_URL}/v1/extract`;
const PARALLEL_TIMEOUT_MS = 60_000;
/** Parallel's cap on a search's session_id, in characters: a longer session is sent as its first SESSION_MAX. */
const SESSION_MAX = 1_000;

/** How Parallel searches and reads, each setting optional (PARALLEL_DEFAULTS); with none, each request is the one the web
 *  tools have always sent:
 *  - `mode`: the search's depth and price (fees.ts PARALLEL_SEARCH_MODE_USD), default "fast";
 *  - `maxCharsTotal`: the most characters of excerpts across a search's results; unset, Parallel's own;
 *  - `includeDomains`, `excludeDomains` (at most 200 together): domains, domain/path prefixes or extensions (".gov") a
 *    search keeps to or leaves out; `afterDate`: the earliest publish date a search keeps, YYYY-MM-DD;
 *  - `maxAgeSeconds`: the oldest cached page a search or extract may answer from before Parallel fetches it live, 600 or
 *    more; unset, Parallel's own (its cache, no live fetch). */
export type ParallelSettings = { mode?: ParallelSearchMode; maxCharsTotal?: number; includeDomains?: string[]; excludeDomains?: string[]; afterDate?: string; maxAgeSeconds?: number };
export const PARALLEL_DEFAULTS = Object.freeze({ mode: "fast" } as const);
const PARALLEL_CHECKS: Readonly<Record<keyof ParallelSettings, Check>> = {
  mode: oneOf(Object.keys(PARALLEL_SEARCH_MODE_USD)),
  maxCharsTotal: wholeIn(1, 10_000_000),
  includeDomains: domains(200),
  excludeDomains: domains(200),
  afterDate: matching(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "a date, YYYY-MM-DD"),
  maxAgeSeconds: wholeIn(600, 315_360_000),
};
export function parallelSettingsProblems(settings: unknown): string[] {
  const problems = settingsProblems("Parallel", settings, PARALLEL_CHECKS);
  const asked = settings as ParallelSettings;
  if (!problems.length && (asked.includeDomains?.length ?? 0) + (asked.excludeDomains?.length ?? 0) > 200) problems.push("Parallel takes at most 200 includeDomains and excludeDomains together");
  return problems;
}
/** The fetch policy `settings` ask, if any. */
const fetchPolicy = (settings: ParallelSettings) => (settings.maxAgeSeconds === undefined ? {} : { fetch_policy: { max_age_seconds: settings.maxAgeSeconds } });

const REFUSED = "Parallel refused this run's key (401 or 403): it is not asked again in this run";
/** Parallel for one run, on one key: `extract`, its extract of a page (one billed request), the page it read or, for
 *  any failure, why it read none, typed; `read`, the same with why in Parallel's words alone; `post`, one request to
 *  another of its endpoints (web_search's, parallelSearched), a URL below Parallel's API. Neither retries, and each stops
 *  at 60 s. `live` is false once a 401 or 403 to either said the key is not served. */
export type Extract = { live(): boolean; extract(url: string, signal?: AbortSignal, client?: WebClient): Promise<Read | Failed>; read(url: string, signal?: AbortSignal, client?: WebClient): Promise<Read | string>; post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> };

/** What Parallel is told of `client` on a search or an extract, as its guidance asks (one session_id for a task's Search
 *  and Extract): its model as client_model, its session as session_id cut at SESSION_MAX, each only where known. */
const clientFields = (client: WebClient): Record<string, string> => ({
  ...(client.model ? { client_model: client.model } : {}),
  ...(client.session ? { session_id: client.session.slice(0, SESSION_MAX) } : {}),
});

/** Parallel's extract on `apiKey`: one URL a request, each a billed extract, its full content to the most of a page
 *  web_fetch reads as the page's text (markdown), its links read from it, status 200 (Parallel answers a page it could
 *  not read in `errors`, with no content), told the read's client (clientFields). */
export function parallelExtract(apiKey: string, send: typeof fetch = fetch, pay: Pay = unmetered, settings: ParallelSettings = {}): Extract {
  // One keyed client for both tools (keyed.ts keyedClient): each request paid through `pay` at its endpoint's price
  // (fees.ts; serve's paid-calls.ts holds it to the run's cap), one with no price, or one the cap refuses, not sent
  // (PaidRefused), a stopped call sending nothing and one that never left not billed (paidSend).
  const client = keyedClient({ who: "Parallel", base: PARALLEL_API_URL, headers: { "x-api-key": apiKey }, feeOf: (path, body) => parallelFeeOf(`${PARALLEL_API_URL}${path}`, body), timeoutMs: PARALLEL_TIMEOUT_MS, refuseOn: [401, 403] }, send, pay);
  const post: Extract["post"] = async (url, body, signal) => {
    // It carries the key: a URL not below Parallel's API is never sent, as a request with no price here.
    if (!url.startsWith(`${PARALLEL_API_URL}/`)) throw new PaidRefused(`Parallel's ${URL.parse(url)?.pathname ?? url} was not sent: it has no price here`);
    return client.post(url.slice(PARALLEL_API_URL.length), body, signal);
  };
  const extract = async (url: string, signal?: AbortSignal, client: WebClient = {}): Promise<Read | Failed> => {
    try {
      // The most of a page a read reaches and one character more, so a page Parallel cut there shows as going on.
      const asked = PAGE_READ_MAX_CHARS + 1;
      const response = await post(PARALLEL_EXTRACT_URL, { urls: [url], advanced_settings: { full_content: { max_chars_per_result: asked }, ...fetchPolicy(settings) }, ...clientFields(client) }, signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) return failed("refused", "KEY_REFUSED", `refused the key (${response.status})`);
        // The key's credit spent holds both tools; a rate limit on an extract holds nothing.
        if (response.status === 402) return keyWide(failed("quota", "HTTP_402", "answered 402", { kind: "quota" }));
        return failed(response.status === 429 ? "rate" : response.status >= 500 ? "infra" : "error", `HTTP_${response.status}`, `answered ${response.status}`);
      }
      const { results, errors } = (await response.json()) as { results?: Array<{ url?: unknown; title?: unknown; full_content?: unknown } | null>; errors?: unknown[] };
      const row = results?.find((r) => typeof r?.url === "string" && typeof r.full_content === "string" && r.full_content.trim() !== "");
      if (!row) return errors?.length ? failed("error", "URL_IN_ERRORS", "listed the URL in errors") : failed("not_text", "NO_TEXT", "answered no content");
      const text = row.full_content as string;
      return markdownRead(row.url as string, typeof row.title === "string" ? row.title : "", text, text.length < asked);
    } catch (error) {
      if (error instanceof PaidRefused) return failed("refused", "CAP_REFUSED", error.message);
      // Said on the page beside Parallel's name: its own words, what an error said cut at 200.
      return thrownFailure(error, { who: "Parallel", what: "fetch", signal, timeout: "timed out", stopped: "was stopped", failedWith: (said) => `failed: ${cutAt(said, 200)}` });
    }
  };
  return {
    live: client.live,
    post,
    extract,
    read: async (url, signal, client) => {
      const read = await extract(url, signal, client);
      return "ok" in read ? read : read.error;
    },
  };
}

/** The /v1/search request for `ask` (searchArgs), under `settings`, as Parallel's guidance for agents asks: the
 *  objective, a goal in plain words, as its objective; the keyword queries as search_queries; and the model and
 *  session of `client` (cut at SESSION_MAX) where the run knows them. Excerpts are Parallel's own length
 *  (max_chars_total where set). */
export function parallelSearchBody({ objective, queries, n }: SearchAsk, settings: ParallelSettings = {}, client: WebClient = {}): Record<string, unknown> {
  const source = {
    ...(settings.includeDomains ? { include_domains: settings.includeDomains } : {}),
    ...(settings.excludeDomains ? { exclude_domains: settings.excludeDomains } : {}),
    ...(settings.afterDate ? { after_date: settings.afterDate } : {}),
  };
  return {
    objective,
    search_queries: queries,
    mode: settings.mode ?? PARALLEL_DEFAULTS.mode,
    ...(settings.maxCharsTotal === undefined ? {} : { max_chars_total: settings.maxCharsTotal }),
    advanced_settings: { max_results: n, ...(Object.keys(source).length ? { source_policy: source } : {}), ...fetchPolicy(settings) },
    ...clientFields(client),
  };
}

/** `{objective, queries?, n?}` (searchArgs) searched through `parallel` (null: the run holds no key) under `settings`,
 *  told `client`, and the limit Parallel answered for the run's key, if any. */
export async function parallelSearched(args: Record<string, unknown>, parallel: Extract | null, signal?: AbortSignal, settings: ParallelSettings = {}, client: WebClient = {}): Promise<Searched> {
  const answer = (search: Search): Searched => ({ answer: search });
  const ask = searchArgs(args);
  const { objective, queries, n } = ask;
  if (!objective) return answer({ error: "web_search needs an objective" });
  if (!parallel) return searchFailed(failed("refused", "NO_KEY", "web_search searches through Parallel, and this run holds no Parallel key (PARALLEL_API_KEY)"));
  if (!parallel.live()) return searchFailed(failed("refused", "KEY_REFUSED", REFUSED));
  try {
    const response = await parallel.post(PARALLEL_SEARCH_URL, parallelSearchBody(ask, settings, client), signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const limit = statusLimit(response);
      if (!parallel.live()) return searchFailed(failed("refused", "KEY_REFUSED", REFUSED));
      const said = failed(limit ? limit.kind : response.status >= 500 ? "infra" : "error", `HTTP_${response.status}`, `Parallel's search answered ${response.status}`, limit);
      return searchFailed(response.status === 402 ? keyWide(said) : said);
    }
    const { results } = (await response.json()) as { results?: unknown };
    const hits = (Array.isArray(results) ? results : []).flatMap((row: { url?: unknown; title?: unknown; publish_date?: unknown; excerpts?: unknown } | null): Hit[] => {
      if (typeof row?.url !== "string") return [];
      const excerpts = Array.isArray(row.excerpts) ? row.excerpts.filter((text): text is string => typeof text === "string") : [];
      return [{ url: row.url, title: typeof row.title === "string" ? clip(row.title, TITLE_CAP) : "", snippet: snippetOf(excerpts.join(" … ")), ...(typeof row.publish_date === "string" ? { published: row.publish_date } : {}) }];
    });
    return answer({ provider: "parallel", objective, queries, results: hits.slice(0, n) });
  } catch (error) {
    if (error instanceof PaidRefused) return searchFailed(failed("refused", "CAP_REFUSED", error.message));
    return searchFailed(thrownFailure(error, { who: "Parallel", what: "search", signal, timeout: "Parallel's search did not answer within 60 s", failedWith: (said) => `Parallel's search failed: ${said}` }));
  }
}

/** web_fetch's reads through `client` (null: the run holds no key), told `told` (the Web's client, each field in place
 *  of which the call's own goes where given, as a search's): a failure in Parallel's words as ours, and why a read is not
 *  asked now (no key, or the key refused earlier in the run). */
export function parallelReads(client: Extract | null, told: WebClient = {}): Required<Pick<ProviderRun, "read" | "unready">> {
  return {
    async read(url, { signal, client: call }) {
      if (!client) return failed("refused", "NO_KEY", "not tried: this run holds no Parallel key");
      return client.extract(url as string, signal, { ...told, ...call });
    },
    unready: () => (!client ? failure("refused", "NO_KEY", "not tried: this run holds no Parallel key") : client.live() ? undefined : failure("refused", "KEY_REFUSED", "not tried: refused earlier in this run")),
  };
}

/** Parallel on the run's key, both tools on one client (a key refused by either is refused by both). Its search keeps
 *  the caller's signal and its own bound; a fetch it gives no page is said on the page. */
export const parallel = defineProvider(
  { id: "parallel", label: "Parallel", key: { env: "PARALLEL_API_KEY" }, ops: ["search", "fetch"], fetch: { miss: "said" }, settings: settingsOf<ParallelSettings>(parallelSettingsProblems) },
  ({ key, send, pay, settings, client: told }): ProviderRun => {
    const asked = (settings ?? {}) as ParallelSettings;
    const client = key === undefined ? null : parallelExtract(key, send ?? fetch, pay, asked);
    return { search: (ask, _deadline, signal, _bounds, call) => parallelSearched(ask, client, signal, asked, { ...told, ...call }), ...parallelReads(client, told) };
  },
);
