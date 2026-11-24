// Keyless Firecrawl: search and scrape through Firecrawl's public MCP endpoint, no key, under a free daily limit. A
// refusal is read by its code alone (quota: off for the run; limit: held for its wait), never by Firecrawl's words. A
// call is never retried and ends at FIRECRAWL_MS. A URL the public-host guard refuses is never sent (fetch.ts).
import { clip, markdownRead, PAGE_MAX_BYTES, type Read, TITLE_CAP, withoutUserinfo } from "../page.js";
import { type Hit, type Limit, type Search, snippetOf, waitOf } from "../search.js";
import { type Bounded, callTool, MAX_BYTES, RATE_LIMITED, textBlocks, type Words } from "./mcp.js";

export const FIRECRAWL_MCP_URL = "https://mcp.firecrawl.dev/v2/mcp";
export const FIRECRAWL_SEARCH_TOOL = "firecrawl_search";
export const FIRECRAWL_SCRAPE_TOOL = "firecrawl_scrape";
/** The most one call to Firecrawl takes: half a search's one deadline (search.ts KEYLESS_SEARCH_MS). */
export const FIRECRAWL_MS = 30_000;
/** Firecrawl's keyless refusal codes, by what the run's breaker makes of each. */
const QUOTA_CODES: ReadonlySet<string> = new Set(["KEYLESS_QUOTA_EXHAUSTED", "KEYLESS_ACCESS_NOT_AVAILABLE", "KEYLESS_TOOL_NOT_AVAILABLE"]);
const RATE_CODES: ReadonlySet<string> = new Set(["KEYLESS_LIMIT_REACHED"]);

/** A call Firecrawl refused or failed, in our words, and the limit it met, if any (for the run's breaker). */
export type FirecrawlFailed = { error: string; limit?: Limit };

/** Where a call goes: `endpoint` (default Firecrawl's), through `send` (default fetch), ended at `timeoutMs` (default
 *  FIRECRAWL_MS) or by `signal`, whichever is first; `words`, the caller's for a rate limit (default RATE_LIMITED). */
export type FirecrawlOptions = { endpoint?: string; send?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; words?: Words };

/** A refusal's payload: the result's structuredContent, else its text read as JSON; undefined when neither is an object. */
function payloadOf(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (isObject(result?.structuredContent) && typeof result.structuredContent.code === "string") return result.structuredContent;
  try {
    const parsed: unknown = JSON.parse(textBlocks(result));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The limit a refusal's `code` names (QUOTA_CODES, RATE_CODES), with the wait its payload names; undefined for any
 *  other code. */
export function firecrawlLimitOf(payload: Record<string, unknown> | undefined): Limit | undefined {
  const code = payload?.code;
  if (typeof code !== "string") return undefined;
  if (QUOTA_CODES.has(code)) return { kind: "quota" };
  if (!RATE_CODES.has(code)) return undefined;
  const seconds = payload!.retry_after_seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return { kind: "rate", retryAfter: seconds };
  return { kind: "rate" };
}

/** What a call answers for a limit Firecrawl met. */
const limitWords = (limit: Limit, what: "search" | "fetch", words: Words = {}): string => (limit.kind === "rate" ? (words.rateLimited ?? RATE_LIMITED) : `Keyless Firecrawl will not serve this server's ${what}es now (its free limit is spent, or keyless use is not open to it): it is not asked again in this run`);

/** One call's outcome as Firecrawl's answer to `what`: its refusals and failures in our words, else `read` of the result's
 *  JSON text. */
function readCalled<T>(called: Bounded, what: "search" | "fetch", read: (json: Record<string, unknown>) => T | FirecrawlFailed, words?: Words): T | FirecrawlFailed {
  if ("status" in called) {
    if (called.status === 429) {
      const limit: Limit = { kind: "rate", ...(called.retryAfterS === undefined ? {} : { retryAfter: called.retryAfterS }) };
      return { error: limitWords(limit, what, words), limit };
    }
    return { error: `Firecrawl's MCP endpoint answered ${called.status} to ${called.step === "initialize" ? "initialize" : `the ${what}`}` };
  }
  if ("over" in called) return { error: `Firecrawl's ${what} answered more than ${called.over / MAX_BYTES} MiB: not read` };
  if ("error" in called) return { error: called.rpc ? `Firecrawl's ${what} failed: its MCP endpoint answered an error` : "Firecrawl's MCP endpoint did not answer initialize" };
  const { result } = called;
  if (result?.isError === true) {
    const payload = payloadOf(result);
    const limit = firecrawlLimitOf(payload);
    if (limit) return { error: limitWords(limit, what, words), limit };
    return { error: typeof payload?.code === "string" ? `Firecrawl's ${what} failed (${clip(payload.code, 60)})` : `Firecrawl's ${what} failed` };
  }
  try {
    const parsed: unknown = JSON.parse(textBlocks(result));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return read(parsed as Record<string, unknown>);
  } catch {}
  return { error: `Firecrawl's ${what} answered no result this server reads` };
}

/** The tool `name` with `args` on Firecrawl's keyless endpoint, its answer bounded at `maxBytes`, read by `read`: once. */
async function firecrawlCall<T>(name: string, args: Record<string, unknown>, what: "search" | "fetch", maxBytes: number, read: (json: Record<string, unknown>) => T | FirecrawlFailed, { endpoint = FIRECRAWL_MCP_URL, send = fetch, signal, timeoutMs = FIRECRAWL_MS, words }: FirecrawlOptions): Promise<T | FirecrawlFailed> {
  const own = AbortSignal.timeout(timeoutMs);
  const deadline = AbortSignal.any([own, ...(signal ? [signal] : [])]);
  try {
    return readCalled(await callTool(endpoint, send, deadline, name, args, maxBytes), what, read, words);
  } catch (error) {
    // Firecrawl's own bound, or the caller's: its deadline (a search's, spent) or its stop.
    if (own.aborted) return { error: `Firecrawl's ${what} did not answer within ${timeoutMs / 1000} s` };
    const reason = signal?.aborted ? (signal.reason as Error)?.name : (error as Error)?.name;
    return { error: reason === "TimeoutError" ? `Firecrawl's ${what} did not answer before the ${what}'s time ran out` : reason === "AbortError" ? `the ${what} was stopped` : `Firecrawl's ${what} failed: ${withoutUserinfo(String((error as Error)?.message ?? error)).slice(0, 300)}` };
  }
}

/** `query` searched on Firecrawl's keyless endpoint, at most `n` results, its answer at most MAX_BYTES. */
export async function firecrawlSearch(query: string, n: number, options: FirecrawlOptions = {}): Promise<Search | FirecrawlFailed> {
  return firecrawlCall<Search>(FIRECRAWL_SEARCH_TOOL, { query, limit: n }, "search", MAX_BYTES, (json) => {
    const data = json.data as { web?: unknown } | unknown[] | undefined;
    const rows = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : undefined;
    if (!rows) return { error: "Firecrawl's search answered no results this server reads" };
    const hits = rows.flatMap((row: { url?: unknown; title?: unknown; description?: unknown } | null): Hit[] => (typeof row?.url === "string" && URL.canParse(row.url) ? [{ url: row.url, title: typeof row.title === "string" ? clip(row.title, TITLE_CAP) : "", snippet: snippetOf(typeof row.description === "string" ? row.description : "") }] : []));
    return { provider: "firecrawl-keyless", query, results: hits.slice(0, n) };
  }, options);
}

/** The page at `url` scraped by Firecrawl's keyless endpoint, as markdown, its answer at most the direct fetch's bound
 *  (PAGE_MAX_BYTES). Firecrawl names no cut, so the text is read as the whole page's. A page whose status
 *  is not 2xx is no read: the caller fetches directly, as for a refusal. */
export async function firecrawlScrape(url: string, options: FirecrawlOptions = {}): Promise<Read | FirecrawlFailed> {
  return firecrawlCall<Read>(FIRECRAWL_SCRAPE_TOOL, { url, formats: ["markdown"] }, "fetch", PAGE_MAX_BYTES, (json) => {
    if (typeof json.markdown !== "string" || json.markdown.trim() === "") return { error: "Firecrawl's fetch answered no page text" };
    const meta = (typeof json.metadata === "object" && json.metadata !== null ? json.metadata : {}) as { title?: unknown; sourceURL?: unknown; url?: unknown; statusCode?: unknown };
    const final = [meta.url, meta.sourceURL].find((one): one is string => typeof one === "string" && URL.canParse(one)) ?? url;
    const status = typeof meta.statusCode === "number" && Number.isInteger(meta.statusCode) ? meta.statusCode : 200;
    if (status < 200 || status > 299) return { error: `Firecrawl's fetch: the page answered ${status}` };
    return markdownRead(final, typeof meta.title === "string" ? meta.title : "", json.markdown, true, status);
  }, options);
}

/** keyless Firecrawl's scrape for one run's web_fetch, with the run's breaker on it: `live` is false once a quota answer
 *  came (for the rest of the run) and while a rate limit's wait holds (waitOf: the wait Firecrawl named, else 60 s, at
 *  most 15 minutes); `read` is one scrape, the page or, for any failure, why there is none (the caller then fetches
 *  directly). `now` is the breaker's clock (a test's). */
export type KeylessFetch = { live(): boolean; read(url: string, signal?: AbortSignal): Promise<Read | string> };
export function firecrawlFetch(options: Omit<FirecrawlOptions, "signal"> = {}, now: () => number = Date.now): KeylessFetch {
  let off = false;
  let until = 0;
  return {
    live: () => !off && now() >= until,
    async read(url, signal) {
      const read = await firecrawlScrape(url, { ...options, ...(signal ? { signal } : {}) });
      if ("ok" in read) return read;
      if (read.limit?.kind === "quota") off = true;
      else if (read.limit) until = Math.max(until, now() + waitOf(read.limit.retryAfter, now()));
      return read.error;
    },
  };
}
