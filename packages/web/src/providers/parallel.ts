// Parallel on the run's key: Extract for web_fetch, Search for web_search. Every request is paid through the injected
// Pay at its endpoint's price, and a 401 or 403 stops both for the client's life. Nothing is retried; each ends at 60 s.
import { type Pay, PaidRefused, parallelFeeOf, unmetered } from "../fees.js";
import { clip, linksWithin, PAGE_READ_MAX_CHARS, type Read, TITLE_CAP, textOf, URL_MAX, withoutUserinfo } from "../page.js";
import { type Hit, type Limit, type Search, type Searched, SNIPPET_MAX, searchArgs, snippetOf } from "../search.js";
import { linksOf } from "../text-urls.js";


export const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
export const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const PARALLEL_TIMEOUT_MS = 60_000;

const REFUSED = "Parallel refused this run's key (401 or 403): it is not asked again in this run";
/** Parallel for one run, on one key: `read`, its extract of a page (one billed request), the page it read or, for any
 *  failure, why it read none; `post`, one request to another of its endpoints (web_search's, parallelSearched). Neither
 *  retries, and each stops at 60 s. `live` is false once a 401 or 403 to either said the key is not served. */
export type Extract = { live(): boolean; read(url: string, signal?: AbortSignal): Promise<Read | string>; post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> };

/** Parallel's extract on `apiKey`: one URL a request, each a billed extract, its full content to the most of a page
 *  web_fetch reads as the page's text (markdown), its links read from it, status 200 (Parallel answers a page it could
 *  not read in `errors`, with no content). */
export function parallelExtract(apiKey: string, send: typeof fetch = fetch, pay: Pay = unmetered): Extract {
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
        const response = await post(PARALLEL_EXTRACT_URL, { urls: [url], advanced_settings: { full_content: { max_chars_per_result: asked } } }, signal);
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
        return name === "TimeoutError" ? "timed out" : name === "AbortError" ? "was stopped" : `failed: ${withoutUserinfo(String((error as Error)?.message ?? error)).slice(0, 200)}`;
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

/** `{query, n?}` searched through `parallel` (null: the run holds no key), and the limit Parallel answered for the run's
 *  key, if any. */
export async function parallelSearched(args: Record<string, unknown>, parallel: Extract | null, signal?: AbortSignal): Promise<Searched> {
  const answer = (search: Search): Searched => ({ answer: search });
  const { query, n } = searchArgs(args);
  if (!query) return answer({ error: "web_search needs a query" });
  if (!parallel) return answer({ error: "web_search searches through Parallel, and this run holds no Parallel key (PARALLEL_API_KEY)" });
  if (!parallel.live()) return answer({ error: REFUSED });
  try {
    const response = await parallel.post(PARALLEL_SEARCH_URL, { objective: query, search_queries: [query], mode: "fast", advanced_settings: { max_results: n, excerpt_settings: { max_chars_per_result: SNIPPET_MAX } } }, signal);
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
