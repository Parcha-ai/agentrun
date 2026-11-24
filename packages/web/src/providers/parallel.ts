// Parallel on the run's key: Extract for web_fetch, Search for web_search. Every request is paid through the injected
// Pay at its endpoint's price, and a 401 or 403 stops both for the client's life. Nothing is retried; each ends at 60 s.
import { type ParallelSearchMode, PARALLEL_SEARCH_MODE_USD, type Pay, PaidRefused, parallelFeeOf, unmetered } from "../fees.js";
import { clip, linksWithin, PAGE_READ_MAX_CHARS, type Read, TITLE_CAP, textOf, URL_MAX } from "../page.js";
import { type Hit, type Limit, type Search, type Searched, SNIPPET_MAX, searchArgs, snippetOf } from "../search.js";
import { defineProvider, type ProviderRun, settingsOf } from "../provider.js";
import { linksOf } from "../text-urls.js";
import { type Check, domains, matching, oneOf, settingsProblems, wholeIn } from "./keyed.js";


export const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
export const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const PARALLEL_TIMEOUT_MS = 60_000;

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
/** Parallel for one run, on one key: `read`, its extract of a page (one billed request), the page it read or, for any
 *  failure, why it read none; `post`, one request to another of its endpoints (web_search's, parallelSearched). Neither
 *  retries, and each stops at 60 s. `live` is false once a 401 or 403 to either said the key is not served. */
export type Extract = { live(): boolean; read(url: string, signal?: AbortSignal): Promise<Read | string>; post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> };

/** Parallel's extract on `apiKey`: one URL a request, each a billed extract, its full content to the most of a page
 *  web_fetch reads as the page's text (markdown), its links read from it, status 200 (Parallel answers a page it could
 *  not read in `errors`, with no content). */
export function parallelExtract(apiKey: string, send: typeof fetch = fetch, pay: Pay = unmetered, settings: ParallelSettings = {}): Extract {
  let refused = false;
  // Each request is a paid one, sent through `pay` (fees.ts; serve's paid-calls.ts holds it to the run's cap and books it
  // as the call's cost at its endpoint's price). One the cap refuses is not sent: it throws its refusal (PaidRefused).
  const post: Extract["post"] = async (url, body, signal) => {
    const sent = async () => {
      const response = await send(url, {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(PARALLEL_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      });
      if (response.status === 401 || response.status === 403) refused = true;
      return response;
    };
    const fee = parallelFeeOf(url, body);
    if (!fee) throw new PaidRefused(`Parallel's ${URL.parse(url)?.pathname ?? url} was not sent: it has no price here`);
    return pay(fee, sent);
  };
  return {
    live: () => !refused,
    post,
    async read(url, signal) {
      try {
        // The most of a page a read reaches and one character more, so a page Parallel cut there shows as going on.
        const asked = PAGE_READ_MAX_CHARS + 1;
        const response = await post(PARALLEL_EXTRACT_URL, { urls: [url], advanced_settings: { full_content: { max_chars_per_result: asked }, ...fetchPolicy(settings) } }, signal);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return response.status === 401 || response.status === 403 ? `refused the key (${response.status})` : `answered ${response.status}`;
        }
        const { results, errors } = (await response.json()) as { results?: Array<{ url?: unknown; title?: unknown; full_content?: unknown } | null>; errors?: unknown[] };
        const row = results?.find((r) => typeof r?.url === "string" && typeof r.full_content === "string" && r.full_content.trim() !== "");
        if (!row) return errors?.length ? "listed the URL in errors" : "answered no content";
        const text = row.full_content as string;
        return { ok: true, url: clip(row.url as string, URL_MAX), status: 200, title: clip(typeof row.title === "string" ? row.title : "", TITLE_CAP), ...textOf(text, text.length < asked), ...linksWithin(linksOf(text)) };
      } catch (error) {
        if (error instanceof PaidRefused) return error.message;
        const name = (error as Error)?.name;
        return name === "TimeoutError" ? "timed out" : name === "AbortError" ? "was stopped" : `failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
      }
    },
  };
}

/** What a Parallel answer's status says of the run's search: out of credit (402), or rate-limited (429) for its
 *  Retry-After. */
const parallelLimit = (response: Response): Limit | undefined => {
  if (response.status === 402) return { kind: "quota" };
  const retryAfter = response.headers.get("retry-after");
  return response.status === 429 ? { kind: "rate", ...(retryAfter ? { retryAfter } : {}) } : undefined;
};

/** The /v1/search request for `query`, `n` results, under `settings`. */
export function parallelSearchBody(query: string, n: number, settings: ParallelSettings = {}): Record<string, unknown> {
  const source = {
    ...(settings.includeDomains ? { include_domains: settings.includeDomains } : {}),
    ...(settings.excludeDomains ? { exclude_domains: settings.excludeDomains } : {}),
    ...(settings.afterDate ? { after_date: settings.afterDate } : {}),
  };
  return {
    objective: query,
    search_queries: [query],
    mode: settings.mode ?? PARALLEL_DEFAULTS.mode,
    ...(settings.maxCharsTotal === undefined ? {} : { max_chars_total: settings.maxCharsTotal }),
    advanced_settings: { max_results: n, excerpt_settings: { max_chars_per_result: SNIPPET_MAX }, ...(Object.keys(source).length ? { source_policy: source } : {}), ...fetchPolicy(settings) },
  };
}

/** `{query, n?}` searched through `parallel` (null: the run holds no key) under `settings`, and the limit Parallel
 *  answered for the run's key, if any. */
export async function parallelSearched(args: Record<string, unknown>, parallel: Extract | null, signal?: AbortSignal, settings: ParallelSettings = {}): Promise<Searched> {
  const answer = (search: Search): Searched => ({ answer: search });
  const { query, n } = searchArgs(args);
  if (!query) return answer({ error: "web_search needs a query" });
  if (!parallel) return answer({ error: "web_search searches through Parallel, and this run holds no Parallel key (PARALLEL_API_KEY)" });
  if (!parallel.live()) return answer({ error: REFUSED });
  try {
    const response = await parallel.post(PARALLEL_SEARCH_URL, parallelSearchBody(query, n, settings), signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const limit = parallelLimit(response);
      return parallel.live() ? { answer: { error: `Parallel's search answered ${response.status}` }, ...(limit ? { limit } : {}) } : answer({ error: REFUSED });
    }
    const { results } = (await response.json()) as { results?: unknown };
    const hits = (Array.isArray(results) ? results : []).flatMap((row: { url?: unknown; title?: unknown; publish_date?: unknown; excerpts?: unknown } | null): Hit[] => {
      if (typeof row?.url !== "string") return [];
      const excerpts = Array.isArray(row.excerpts) ? row.excerpts.filter((text): text is string => typeof text === "string") : [];
      return [{ url: row.url, title: typeof row.title === "string" ? clip(row.title, TITLE_CAP) : "", snippet: snippetOf(excerpts.join(" … ")), ...(typeof row.publish_date === "string" ? { published: row.publish_date } : {}) }];
    });
    return answer({ provider: "parallel", query, results: hits.slice(0, n) });
  } catch (error) {
    if (error instanceof PaidRefused) return answer({ error: error.message });
    return answer({ error: (error as Error)?.name === "TimeoutError" ? "Parallel's search did not answer within 60 s" : `Parallel's search failed: ${(error as Error)?.message ?? String(error)}` });
  }
}

/** web_fetch's reads through `client` (null: the run holds no key): a failure in Parallel's words as ours, and why a
 *  read is not asked now (no key, or the key refused earlier in the run). */
export function parallelReads(client: Extract | null): Required<Pick<ProviderRun, "read" | "unready">> {
  return {
    async read(url, { signal }) {
      if (!client) return { error: "not tried: this run holds no Parallel key" };
      const read = await client.read(url as string, signal);
      return typeof read === "string" ? { error: read } : read;
    },
    unready: () => (!client ? "not tried: this run holds no Parallel key" : client.live() ? undefined : "not tried: refused earlier in this run"),
  };
}

/** Parallel on the run's key, both tools on one client (a key refused by either is refused by both). Its search keeps
 *  the caller's signal and its own bound; a fetch it gives no page is said on the page. */
export const parallel = defineProvider(
  { id: "parallel", label: "Parallel", key: { env: "PARALLEL_API_KEY" }, ops: ["search", "fetch"], fetch: { miss: "said" }, settings: settingsOf<ParallelSettings>(parallelSettingsProblems) },
  ({ key, send, pay, settings }): ProviderRun => {
    const asked = (settings ?? {}) as ParallelSettings;
    const client = key === undefined ? null : parallelExtract(key, send ?? fetch, pay, asked);
    return { search: (ask, _deadline, signal) => parallelSearched(ask, client, signal, asked), ...parallelReads(client) };
  },
);
