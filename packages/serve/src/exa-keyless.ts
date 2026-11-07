// web_search's keyless fallback: Exa's public MCP endpoint (https://mcp.exa.ai/mcp, docs.exa.ai/reference/exa-mcp),
// which answers its `web_search_exa` tool with no key at a free rate limit. One search is one MCP exchange over its
// streamable HTTP transport: `initialize` (its session id, when it names one), `notifications/initialized`, then
// `tools/call` of web_search_exa with `{query, numResults}`, at most 8. Exa answers one text block, a result per section split by
// `---` lines, each `Title:`, `URL:`, `Published:`, `Author:`, then `Highlights:` (or `Text:`) and its lines; a `Note:`
// line may lead it. That text is read into the same Search every web_search answers, and no more than 1 MiB of an
// answer is read. Past its free limit Exa answers a 429 with Retry-After, or (when its search API refuses the keyless
// call) a 200 whose tool result is marked isError and `ai.exa/rateLimited`, its text telling the user to put an API key
// in their MCP URL. Either is tried once more, a new exchange after a jittered 1 to 3 s or the Retry-After Exa names when
// it is 5 s or less (past that, as with its daily limit, the limit does not lift within a search, and it is not tried
// again); still limited, the search answers RATE_LIMITED, in our words, never Exa's. Any other failure Exa answers is
// ours too, quoting only the first sentence of Exa's (exaSaid). A 403 is a connection keyless use
// refuses (Exa takes it over IPv4, straight to the endpoint), never tried again. Both say which limit they met
// (ExaLimited), for the caller's fallback. A search ends at 60 s, its retry and wait included. No key is sent, ever.
// Exa is dialled over IPv4 alone (ipv4Fetch): its name looked up for family 4 and the connection made to that address,
// so a host whose default route is IPv6 reaches it the one way keyless use is taken.
import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import type { Agent } from "undici";
import { clip, TITLE_CAP } from "./web-fetch-direct.js";
import { type Hit, type Search, snippetOf } from "./web-search.js";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_SEARCH_TOOL = "web_search_exa";
/** Under `--faux` only: a module whose default export is the fetch Exa's MCP exchange goes through (the tests' fake
 *  MCP server), in place of Exa's endpoint. */
export const FAUX_EXA_ENV = "AGENTRUN_SERVE_FAUX_EXA";
/** The MCP revision this client speaks; the server answers the one it takes. */
const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 60_000;
/** The most results Exa's free endpoint is asked for (its default is 10). Its own cap on purpose, not web search's
 *  RESULTS_MAX: the hosted providers take more, and Exa's keyless limit is per request. */
const RESULTS_MAX = 8;
const ACCEPT = "application/json, text/event-stream";
/** The most of an answer read: a search's text is a few kilobytes; past this the rest is never read. */
const MAX_BYTES = 1 << 20;

/** What a search answers when Exa's free limit holds after the one retry. Exa's own words name a fix (an API key in
 *  its MCP URL) that means nothing to a person here, so they are never passed on. */
export const RATE_LIMITED = "Free web search is rate-limited right now. Try again in a minute, or add a Parallel key in Settings → Tool keys to search with a key.";
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

type Rpc = { result?: Record<string, unknown>; error?: { message?: unknown } };

/** The seconds a Retry-After names, as seconds or a date; undefined when it names none. */
function retryAfterOf(response: Response): number | undefined {
  const said = response.headers.get("retry-after")?.trim();
  if (!said) return undefined;
  if (/^\d+$/.test(said)) return Number(said);
  const at = Date.parse(said);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** The wait before the one retry: the Retry-After Exa named, else 1 to 3 s, each with jitter so runs limited together
 *  do not all ask again at once. */
const waitOf = (retryAfterS: number | undefined) => (retryAfterS === undefined ? 1_000 + Math.random() * 2_000 : retryAfterS * 1_000 + Math.random() * 500);

/** `ms` of waiting that `signal` ends, rejecting with its reason. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });

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

/** At most MAX_BYTES of a body, as text; the rest is not read. */
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  for (let size = 0; reader && size < MAX_BYTES; ) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader?.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8");
}

/** A JSON-RPC answer's body: JSON, or the `data:` lines of an event stream, the one answering `id`. */
async function answerOf(response: Response, id: number): Promise<Rpc | undefined> {
  const text = await boundedText(response);
  const messages = /event-stream/i.test(response.headers.get("content-type") ?? "")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [text];
  for (const message of messages) {
    try {
      const parsed = JSON.parse(message) as Rpc & { id?: unknown };
      if (parsed.id === id) return parsed;
    } catch {}
  }
  return undefined;
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

/** `query` searched on Exa's keyless MCP endpoint through `send` (a test's fake; default a fetch over IPv4 alone,
 *  ipv4Fetch, closed when the search ends), at most `n` results: once, and once more past Exa's free limit after
 *  `pause` (default a wait the search's signal ends; a test's records it). */
export async function exaSearch(query: string, n: number, { send, signal, pause = sleep }: { send?: typeof fetch; signal?: AbortSignal; pause?: (ms: number, signal: AbortSignal) => Promise<void> } = {}): Promise<Search | ExaLimited> {
  const deadline = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
  const own = send ? undefined : ipv4Fetch();
  const dial = send ?? own!.send;
  try {
    const first = await exchange(query, n, dial, deadline);
    if (!("limit" in first) || first.limit !== "rate_limited" || (first.retryAfterS ?? 0) > RETRY_AFTER_MAX_S) return first;
    await pause(waitOf(first.retryAfterS), deadline);
    return await exchange(query, n, dial, deadline);
  } catch (error) {
    const name = (error as Error)?.name;
    return { error: name === "TimeoutError" ? "Exa's search did not answer within 60 s" : name === "AbortError" ? "the search was stopped" : `Exa's search failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
  } finally {
    await own?.close().catch(() => undefined);
  }
}

/** One MCP exchange searching `query` through `dial`, each request ended by `deadline`; a failure to reach Exa throws. */
async function exchange(query: string, n: number, dial: typeof fetch, deadline: AbortSignal): Promise<Search | ExaLimited> {
  let session: string | undefined;
  const post = (body: Record<string, unknown>) =>
    dial(EXA_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT, "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: deadline,
    });
  const refused = async (response: Response, step: string): Promise<Search | ExaLimited | undefined> => {
    if (response.ok) return undefined;
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) {
      const retryAfterS = retryAfterOf(response);
      return { error: RATE_LIMITED, limit: "rate_limited", ...(retryAfterS === undefined ? {} : { retryAfterS }) };
    }
    if (response.status === 403) return { error: "Exa refused keyless use from this connection (403): it takes keyless searches only over IPv4, straight to its endpoint, not over IPv6 or through a proxy", limit: "connection_refused" };
    return { error: `Exa's MCP endpoint answered ${response.status} to ${step}` };
  };
  const opened = await post({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "agentrun-serve", version: "1" } } });
  const failed = await refused(opened, "initialize");
  if (failed) return failed;
  session = opened.headers.get("mcp-session-id") ?? undefined;
  if (!(await answerOf(opened, 1))?.result) return { error: "Exa's MCP endpoint did not answer initialize" };
  const ready = await post({ method: "notifications/initialized" });
  await ready.body?.cancel().catch(() => undefined);
  const called = await post({ id: 2, method: "tools/call", params: { name: EXA_SEARCH_TOOL, arguments: { query, numResults: Math.min(n, RESULTS_MAX) } } });
  const late = await refused(called, "the search");
  if (late) return late;
  const answer = await answerOf(called, 2);
  if (answer?.error) return { error: exaSaid(typeof answer.error.message === "string" ? answer.error.message : "") };
  const meta = answer?.result?._meta;
  if (answer?.result?.isError === true && typeof meta === "object" && meta !== null && (meta as Record<string, unknown>)[RATE_LIMITED_META] === true) return { error: RATE_LIMITED, limit: "rate_limited" };
  const content = Array.isArray(answer?.result?.content) ? (answer.result.content as { type?: unknown; text?: unknown }[]) : undefined;
  const said = content?.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n") ?? "";
  if (!content || answer?.result?.isError === true) return { error: exaSaid(said) };
  const hits = said.split(/\n-{3,}\n/).flatMap((section) => hitOf(section) ?? []);
  return { provider: "exa-keyless", query, results: hits.slice(0, n) };
}
