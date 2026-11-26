// Keyless Exa: web_search through Exa's public MCP endpoint, no key, at a free rate limit. A limited search is tried
// once more after a short wait (a Retry-After of 5 s at most); still limited, it answers the caller's words, never Exa's.
// Exa is dialled over IPv4 only, the one way it takes keyless use.
import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import type { Agent } from "undici";
import { clip, TITLE_CAP } from "../page.js";
import { defineProvider, type ProviderRun } from "../provider.js";
import { bare, type Failure, type FailureClass, type Hit, type Limit, type Search, type SearchAsk, snippetOf } from "../search.js";
import { type Called, callTool, RATE_LIMITED, sleep, textBlocks, type Words } from "./mcp.js";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_SEARCH_TOOL = "web_search_exa";
const TIMEOUT_MS = 60_000;
/** The most results Exa's free endpoint is asked for (its default is 10). Its own cap on purpose, not web search's
 *  RESULTS_MAX: the hosted providers take more, and Exa's keyless limit is per request. */
const RESULTS_MAX = 8;

/** The most of Exa's own words a failure quotes: the first sentence of its first line, cut on a word. */
const SAID_MAX = 120;
/** A failure Exa answered, in our words: the first sentence of its text, short and quoted. Its later lines (a fix for its
 *  MCP URL, a timestamp) are never passed on, so a deployment that does not mark its free limit says no setup text. */
function exaSaid(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  const short = sentence.length <= SAID_MAX ? sentence : `${sentence.slice(0, SAID_MAX - 1).replace(/\s+\S*$/, "")}…`;
  return short ? `Free web search failed. Exa said: "${short}"` : "Free web search failed: Exa gave no answer";
}
/** The `_meta` key Exa's MCP server marks a tool result reporting its free limit with (isError as well). */
const RATE_LIMITED_META = "ai.exa/rateLimited";
/** The longest Retry-After waited out before the one retry. */
const RETRY_AFTER_MAX_S = 5;

/** A search Exa refused for its free limit (`retryAfterS`, the wait it named, when it named one) or for the connection
 *  (403): a reason another provider may get past, which the caller reads before the model reads `error` alone. */
export type ExaLimited = { error: string; limit: "rate_limited"; retryAfterS?: number } | { error: string; limit: "connection_refused" };

/** A failed search with its failure typed (the provider's own; exaSearch answers it bare). */
type Typed = (ExaLimited | { error: string }) & { failure: Failure };
const typed = <T extends { error: string }>(kind: FailureClass, code: string, found: T): T & { failure: Failure } => ({ ...found, failure: { class: kind, code, message: found.error } });

/** The wait before the one retry: the Retry-After Exa named, else 1 to 3 s, each with jitter so runs limited together
 *  do not all ask again at once. */
const retryPause = (retryAfterS: number | undefined) => (retryAfterS === undefined ? 1_000 + Math.random() * 2_000 : retryAfterS * 1_000 + Math.random() * 500);

/** A fetch that reaches hosts over IPv4 alone: each name looked up for family 4 (through `lookup`, default the system
 *  resolver) and the connection dialled at the address found, never an IPv6 one. undici loads at the first request, so
 *  a run that never searches never loads it; `close` ends the connections. */
export function ipv4Fetch(lookup: LookupFunction = dnsLookup as LookupFunction): { send: typeof fetch; close(): Promise<void> } {
  const ipv4: LookupFunction = (host, options, callback) => lookup(host, { ...options, family: 4 }, callback);
  let opened: Promise<{ dispatcher: Agent; dial: typeof import("undici").fetch }> | undefined;
  const open = () => (opened ??= import("undici").then(({ Agent, fetch }) => ({ dispatcher: new Agent({ connect: { family: 4, lookup: ipv4 } }), dial: fetch })));
  const send = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { dispatcher, dial } = await open();
    return dial(url as never, { ...init, dispatcher } as never) as unknown as Promise<Response>;
  };
  return { send: send as typeof fetch, close: async () => void (opened && (await (await opened).dispatcher.close())) };
}

/** Exa's text for one result as a Hit, or undefined when it names no URL. */
function hitOf(section: string): Hit | undefined {
  const lines = section.split("\n");
  const field = (name: string) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
  const url = field("URL");
  if (!url || !URL.canParse(url)) return undefined;
  const known = (value: string | undefined) => (value && value !== "N/A" ? value : undefined);
  const body = lines.findIndex((line) => /^(Highlights|Text):/.test(line));
  const snippet = body < 0 ? "" : [lines[body]!.replace(/^(Highlights|Text):\s*/, ""), ...lines.slice(body + 1)].join(" ").trim();
  const published = known(field("Published"));
  return { url, title: clip(known(field("Title")) ?? "", TITLE_CAP), snippet: snippetOf(snippet), ...(published ? { published } : {}) };
}

/** One exchange's outcome as Exa's answer to a search for `ask`'s objective, at most `ask.n` results: its refusals and
 *  failures in our words, else its hits. */
function searchOf(called: Called, { objective, queries, n }: SearchAsk, rateLimited: string): Search | Typed {
  if ("status" in called) {
    if (called.status === 429) return typed("rate", "HTTP_429", { error: rateLimited, limit: "rate_limited" as const, ...(called.retryAfterS === undefined ? {} : { retryAfterS: called.retryAfterS }) });
    if (called.status === 403) return typed("refused", "CONNECTION_REFUSED", { error: "Exa refused keyless use from this connection (403): it takes keyless searches only over IPv4, straight to its endpoint, not over IPv6 or through a proxy", limit: "connection_refused" as const });
    return typed("infra", `HTTP_${called.status}`, { error: `Exa's MCP endpoint answered ${called.status} to ${called.step === "initialize" ? "initialize" : "the search"}` });
  }
  if ("error" in called) return called.rpc ? typed("error", "RPC_ERROR", { error: exaSaid(called.error) }) : typed("infra", "NO_INITIALIZE", { error: "Exa's MCP endpoint did not answer initialize" });
  const { result } = called;
  const meta = result?._meta;
  if (result?.isError === true && typeof meta === "object" && meta !== null && (meta as Record<string, unknown>)[RATE_LIMITED_META] === true) return typed("rate", "RATE_LIMITED", { error: rateLimited, limit: "rate_limited" as const });
  const said = textBlocks(result);
  if (!Array.isArray(result?.content) || result.isError === true) return typed("error", "FAILED", { error: exaSaid(said) });
  const hits = said.split(/\n-{3,}\n/).flatMap((section) => hitOf(section) ?? []);
  return { provider: "exa-keyless", objective, queries, results: hits.slice(0, n) };
}

/** `query` searched on Exa's keyless MCP endpoint through `send` (a test's fake; default a fetch over IPv4 alone,
 *  ipv4Fetch, closed when the search ends), at most `n` results: once, and once more past Exa's free limit after
 *  `pause` (default a wait the search's signal ends; a test's records it). `words`: the caller's for its free limit. */
export async function exaSearch(query: string, n: number, options: ExaOptions = {}): Promise<Search | ExaLimited> {
  return bare(await searchTyped({ objective: query, queries: [query], n }, options));
}

/** What exaSearch takes: the fetch, the caller's signal, the pause before its one retry, the caller's words. */
type ExaOptions = { send?: typeof fetch; signal?: AbortSignal; pause?: (ms: number, signal: AbortSignal) => Promise<void>; words?: Words };
/** `ask` searched as exaSearch searches, its objective as Exa's query, a failure typed. */
async function searchTyped(ask: SearchAsk, { send, signal, pause = sleep, words = {} }: ExaOptions): Promise<Search | Typed> {
  const deadline = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
  const own = send ? undefined : ipv4Fetch();
  const dial = send ?? own!.send;
  const once = async () => searchOf(await callTool(EXA_MCP_URL, dial, deadline, EXA_SEARCH_TOOL, { query: ask.objective, numResults: Math.min(ask.n, RESULTS_MAX) }), ask, words.rateLimited ?? RATE_LIMITED);
  try {
    const first = await once();
    if (!("limit" in first) || first.limit !== "rate_limited" || (first.retryAfterS ?? 0) > RETRY_AFTER_MAX_S) return first;
    await pause(retryPause(first.retryAfterS), deadline);
    return await once();
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === "TimeoutError") return typed("infra", "TIMEOUT", { error: "Exa's search did not answer within 60 s" });
    return name === "AbortError" ? typed("infra", "STOPPED", { error: "the search was stopped" }) : typed("infra", "CONNECT", { error: `Exa's search failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` });
  } finally {
    await own?.close().catch(() => undefined);
  }
}

/** Keyless Exa's refusal as the run's breaker reads it: a rate limit, with the wait it named. One naming no wait (its MCP
 *  notice, as its daily count running out answers) is marked repeatIsQuota, so a second one past a wait is that count; a
 *  429 with Retry-After is a timed limit, unmarked. A refused connection is no limit (a 403 no wait lifts). */
export function exaLimitOf(found: ExaLimited): Limit | undefined {
  if (found.limit !== "rate_limited") return undefined;
  return found.retryAfterS === undefined ? { kind: "rate", repeatIsQuota: true } : { kind: "rate", retryAfter: found.retryAfterS };
}

/** Keyless Exa, web_search only: ended by the call's deadline; its free limit is the breaker's (exaLimitOf), its words
 *  the model's alone. */
export const exaKeyless = defineProvider({ id: "exa-keyless", label: "Exa", keyless: true, ops: ["search"] }, ({ send, words }): ProviderRun => ({
  async search(ask, deadline) {
    const found = await searchTyped(ask, { ...(send ? { send } : {}), ...(words ? { words } : {}), signal: deadline });
    if (!("failure" in found)) return { answer: found };
    const limit = "limit" in found ? exaLimitOf(found) : undefined;
    return { answer: { error: found.error }, failure: found.failure, ...(limit ? { limit } : {}) };
  },
}));
