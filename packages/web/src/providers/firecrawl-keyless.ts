// Keyless Firecrawl: search and scrape through Firecrawl's public MCP endpoint, no key, under a free daily limit. A
// refusal is read by its code (quota: off for the run; limit: held for its wait), and a spent daily limit by the one
// plain-text answer Firecrawl gives for it (off until 00:00 UTC). Firecrawl's words are never passed on. A call is never
// retried and ends at FIRECRAWL_MS. A URL the public-host guard refuses is never sent (fetch.ts).
import { clip, markdownRead, PAGE_MAX_BYTES, type Read, TITLE_CAP, withoutUserinfo } from "../page.js";
import { defineProvider, type ProviderRun, type Reader, readerOf } from "../provider.js";
import { bare, type Failed, failed, type Hit, keyWide, type Limit, type Search, searchBreaker, searchFailed, snippetOf } from "../search.js";
import { type Bounded, callTool, MAX_BYTES, RATE_LIMITED, textBlocks, type Words } from "./mcp.js";

export const FIRECRAWL_MCP_URL = "https://mcp.firecrawl.dev/v2/mcp";
export const FIRECRAWL_SEARCH_TOOL = "firecrawl_search";
export const FIRECRAWL_SCRAPE_TOOL = "firecrawl_scrape";
/** The most one call to Firecrawl takes: half a search's one deadline (search.ts KEYLESS_SEARCH_MS). */
export const FIRECRAWL_MS = 30_000;
/** Firecrawl's keyless refusal codes, by what the run's breaker makes of each; of the quotas, those of the host's whole
 *  keyless allowance (KEY_QUOTA_CODES) hold both tools, the one tool's (KEYLESS_TOOL_NOT_AVAILABLE) its tool alone. */
const QUOTA_CODES: ReadonlySet<string> = new Set(["KEYLESS_QUOTA_EXHAUSTED", "KEYLESS_ACCESS_NOT_AVAILABLE", "KEYLESS_TOOL_NOT_AVAILABLE"]);
const KEY_QUOTA_CODES: ReadonlySet<string> = new Set(["KEYLESS_QUOTA_EXHAUSTED", "KEYLESS_ACCESS_NOT_AVAILABLE"]);
const RATE_CODES: ReadonlySet<string> = new Set(["KEYLESS_LIMIT_REACHED"]);
/** Firecrawl's answer once its keyless daily limit is spent: plain text, with no code, as a tool result marked isError
 *  or a JSON-RPC error. */
const DAILY_LIMIT = /daily limit without an account was reached/i;

/** A spent daily limit, met at `nowMs`: a quota until the next 00:00 UTC, as an HTTP date (Firecrawl names no reset). */
function dailyLimitAt(nowMs: number): Limit {
  const day = new Date(nowMs);
  return { kind: "quota", retryAfter: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)).toUTCString() };
}

/** A call Firecrawl refused or failed, in our words, and the limit it met, if any (for the run's breaker). */
export type FirecrawlFailed = { error: string; limit?: Limit };
/** The same, typed (the provider's own; firecrawlSearch and firecrawlScrape answer it bare). */
type Typed = Failed;

/** Where a call goes: `endpoint` (default Firecrawl's), through `send` (default fetch), ended at `timeoutMs` (default
 *  FIRECRAWL_MS) or by `signal`, whichever is first; `words`, the caller's for a rate limit (default RATE_LIMITED);
 *  `now`, the clock a daily limit's reset is read on (the breaker's; default Date.now). */
export type FirecrawlOptions = { endpoint?: string; send?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; words?: Words; now?: () => number };

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
function limitWords(limit: Limit, what: "search" | "fetch", words: Words = {}): string {
  if (limit.kind === "rate") return words.rateLimited ?? RATE_LIMITED;
  if (limit.retryAfter !== undefined) return `Keyless Firecrawl will not serve this server's ${what}es now (its free daily limit is spent): it is not asked again before 00:00 UTC`;
  return `Keyless Firecrawl will not serve this server's ${what}es now (its free limit is spent, or keyless use is not open to it): it is not asked again in this run`;
}

/** One call's outcome as Firecrawl's answer to `what`: its refusals and failures in our words, else `read` of the result's
 *  JSON text. */
function readCalled<T>(called: Bounded, what: "search" | "fetch", read: (json: Record<string, unknown>) => T | Typed, words: Words | undefined, now: () => number): T | Typed {
  const spent = (said: string): Typed | undefined => {
    if (!DAILY_LIMIT.test(said)) return undefined;
    const limit = dailyLimitAt(now());
    // The host's daily allowance, for both tools.
    return keyWide(failed("quota", "DAILY_LIMIT", limitWords(limit, what, words), limit));
  };
  if ("status" in called) {
    if (called.status === 429) {
      const limit: Limit = { kind: "rate", ...(called.retryAfterS === undefined ? {} : { retryAfter: called.retryAfterS }) };
      return failed("rate", "HTTP_429", limitWords(limit, what, words), limit);
    }
    return failed("infra", `HTTP_${called.status}`, `Firecrawl's MCP endpoint answered ${called.status} to ${called.step === "initialize" ? "initialize" : `the ${what}`}`);
  }
  if ("over" in called) return failed("error", "TOO_LARGE", `Firecrawl's ${what} answered more than ${called.over / MAX_BYTES} MiB: not read`);
  if ("error" in called) return (called.rpc ? spent(called.error) : undefined) ?? (called.rpc ? failed("error", "RPC_ERROR", `Firecrawl's ${what} failed: its MCP endpoint answered an error`) : failed("infra", "NO_INITIALIZE", "Firecrawl's MCP endpoint did not answer initialize"));
  const { result } = called;
  if (result?.isError === true) {
    const payload = payloadOf(result);
    const code = typeof payload?.code === "string" ? clip(payload.code, 60) : undefined;
    const limit = firecrawlLimitOf(payload);
    if (limit) {
      const said = failed(limit.kind, code!, limitWords(limit, what, words), limit);
      return KEY_QUOTA_CODES.has(code!) ? keyWide(said) : said;
    }
    const daily = payload ? undefined : spent(textBlocks(result));
    if (daily) return daily;
    return failed("error", code ?? "FAILED", code ? `Firecrawl's ${what} failed (${code})` : `Firecrawl's ${what} failed`);
  }
  try {
    const parsed: unknown = JSON.parse(textBlocks(result));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return read(parsed as Record<string, unknown>);
  } catch {}
  return failed("error", "UNREADABLE", `Firecrawl's ${what} answered no result this server reads`);
}

/** The tool `name` with `args` on Firecrawl's keyless endpoint, its answer bounded at `maxBytes`, read by `read`: once. */
async function firecrawlCall<T>(name: string, args: Record<string, unknown>, what: "search" | "fetch", maxBytes: number, read: (json: Record<string, unknown>) => T | Typed, { endpoint = FIRECRAWL_MCP_URL, send = fetch, signal, timeoutMs = FIRECRAWL_MS, words, now = Date.now }: FirecrawlOptions): Promise<T | Typed> {
  const own = AbortSignal.timeout(timeoutMs);
  const deadline = AbortSignal.any([own, ...(signal ? [signal] : [])]);
  try {
    return readCalled(await callTool(endpoint, send, deadline, name, args, maxBytes), what, read, words, now);
  } catch (error) {
    // Firecrawl's own bound, or the caller's: its deadline (a search's, spent) or its stop.
    if (own.aborted) return failed("infra", "TIMEOUT", `Firecrawl's ${what} did not answer within ${timeoutMs / 1000} s`);
    const reason = signal?.aborted ? (signal.reason as Error)?.name : (error as Error)?.name;
    if (reason === "TimeoutError") return failed("infra", "DEADLINE", `Firecrawl's ${what} did not answer before the ${what}'s time ran out`);
    return reason === "AbortError" ? failed("infra", "STOPPED", `the ${what} was stopped`) : failed("infra", "CONNECT", `Firecrawl's ${what} failed: ${withoutUserinfo(String((error as Error)?.message ?? error)).slice(0, 300)}`);
  }
}

/** `query` searched on Firecrawl's keyless endpoint, at most `n` results, its answer at most MAX_BYTES; a failure typed. */
function searchTyped(query: string, n: number, options: FirecrawlOptions): Promise<Search | Typed> {
  return firecrawlCall<Search>(FIRECRAWL_SEARCH_TOOL, { query, limit: n }, "search", MAX_BYTES, (json) => {
    const data = json.data as { web?: unknown } | unknown[] | undefined;
    const rows = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : undefined;
    if (!rows) return failed("error", "UNREADABLE", "Firecrawl's search answered no results this server reads");
    const hits = rows.flatMap((row: { url?: unknown; title?: unknown; description?: unknown } | null): Hit[] => (typeof row?.url === "string" && URL.canParse(row.url) ? [{ url: row.url, title: typeof row.title === "string" ? clip(row.title, TITLE_CAP) : "", snippet: snippetOf(typeof row.description === "string" ? row.description : "") }] : []));
    return { provider: "firecrawl-keyless", query, results: hits.slice(0, n) };
  }, options);
}

/** `query` searched on Firecrawl's keyless endpoint, at most `n` results, its answer at most MAX_BYTES. */
export async function firecrawlSearch(query: string, n: number, options: FirecrawlOptions = {}): Promise<Search | FirecrawlFailed> {
  return bare(await searchTyped(query, n, options));
}

/** The page at `url` scraped by Firecrawl's keyless endpoint, as markdown, its answer at most the direct fetch's bound
 *  (PAGE_MAX_BYTES), a failure typed. Firecrawl names no cut, so the text is read as the whole page's. A page whose
 *  status is not 2xx is no read: the caller fetches directly, as for a refusal. */
function scrapeTyped(url: string, options: FirecrawlOptions): Promise<Read | Typed> {
  return firecrawlCall<Read>(FIRECRAWL_SCRAPE_TOOL, { url, formats: ["markdown"] }, "fetch", PAGE_MAX_BYTES, (json) => {
    if (typeof json.markdown !== "string" || json.markdown.trim() === "") return failed("not_text", "NO_TEXT", "Firecrawl's fetch answered no page text");
    const meta = (typeof json.metadata === "object" && json.metadata !== null ? json.metadata : {}) as { title?: unknown; sourceURL?: unknown; url?: unknown; statusCode?: unknown };
    const final = [meta.url, meta.sourceURL].find((one): one is string => typeof one === "string" && URL.canParse(one)) ?? url;
    const status = typeof meta.statusCode === "number" && Number.isInteger(meta.statusCode) ? meta.statusCode : 200;
    if (status < 200 || status > 299) return failed("error", `PAGE_${status}`, `Firecrawl's fetch: the page answered ${status}`);
    return markdownRead(final, typeof meta.title === "string" ? meta.title : "", json.markdown, true, status);
  }, options);
}

/** firecrawlScrape's page, or why there is none (as scrapeTyped, bare). */
export async function firecrawlScrape(url: string, options: FirecrawlOptions = {}): Promise<Read | FirecrawlFailed> {
  return bare(await scrapeTyped(url, options));
}

/** keyless Firecrawl's scrape for one run's web_fetch behind its own breaker (readerOf, on searchBreaker at `now`): held
 *  while a limit keeps it off or a rate limit's wait holds; each read one scrape, the page or why there is none. */
export function firecrawlFetch(options: Omit<FirecrawlOptions, "signal" | "now"> = {}, now: () => number = Date.now): Reader {
  return readerOf({ read: (url, { signal }) => scrapeTyped(url as string, { ...options, now, ...(signal ? { signal } : {}) }) }, searchBreaker(now));
}

/** Keyless Firecrawl: search and scrape on its public MCP endpoint (or `endpoint`). Its search ends at the call's deadline
 *  or its own bound (`bounds.firecrawlMs`: the call's where it gives one, else the Web's; default FIRECRAWL_MS); why a
 *  fetch gave no page is said on the page in our words (Firecrawl's own are never passed on) and logged once the direct
 *  fetch has answered. */
export const firecrawlKeyless = defineProvider(
  { id: "firecrawl-keyless", label: "Firecrawl", keyless: true, ops: ["search", "fetch"], fetch: { miss: { log: "web_fetch_firecrawl_failed", when: "ends" } } },
  ({ endpoint, send, words, now, bounds }): ProviderRun => {
    const options: Omit<FirecrawlOptions, "signal"> = { ...(endpoint ? { endpoint } : {}), ...(send ? { send } : {}), ...(words ? { words } : {}), now };
    return {
      async search({ query, n }, deadline, _signal, called) {
        const firecrawlMs = called?.firecrawlMs ?? bounds?.firecrawlMs;
        const found = await searchTyped(query, n, { ...options, signal: deadline, ...(firecrawlMs === undefined ? {} : { timeoutMs: firecrawlMs }) });
        // Which limit Firecrawl met is the breaker's to read, never the model's.
        return "error" in found ? searchFailed(found as Typed) : { answer: found };
      },
      read: (url, { signal }) => scrapeTyped(url as string, { ...options, ...(signal ? { signal } : {}) }),
    };
  },
);
