// web_search's keyless fallback: Exa's public MCP endpoint (https://mcp.exa.ai/mcp, docs.exa.ai/reference/exa-mcp),
// which answers its `web_search_exa` tool with no key at a free rate limit. One search is one MCP exchange over its
// streamable HTTP transport: `initialize` (its session id, when it names one), `notifications/initialized`, then
// `tools/call` of web_search_exa with `{query, numResults}`, at most 8. Exa answers one text block, a result per section split by
// `---` lines, each `Title:`, `URL:`, `Published:`, `Author:`, then `Highlights:` (or `Text:`) and its lines; a `Note:`
// line may lead it. That text is read into the same Search every web_search answers, and no more than 1 MiB of an
// answer is read. Over the free limit Exa answers 429, which is said as such with its Retry-After; a 403 is a connection keyless use refuses (Exa takes it over IPv4,
// straight to the endpoint). Nothing is retried, and each exchange ends at 60 s. No key is sent, ever.
import { clip, TITLE_CAP } from "./fetch-page.js";
import { type Hit, type Search, snippetOf } from "./web-search.js";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_SEARCH_TOOL = "web_search_exa";
/** Under `--faux` only: a module whose default export is the fetch Exa's MCP exchange goes through (the tests' fake
 *  MCP server), in place of Exa's endpoint. */
export const FAUX_EXA_ENV = "AGENTRUN_SERVE_FAUX_EXA";
/** The MCP revision this client speaks; the server answers the one it takes. */
const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 60_000;
/** The most results Exa is asked for (its default is 10). */
const RESULTS_MAX = 8;
const ACCEPT = "application/json, text/event-stream";
/** The most of an answer read: a search's text is a few kilobytes; past this the rest is never read. */
const MAX_BYTES = 1 << 20;

type Rpc = { result?: Record<string, unknown>; error?: { message?: unknown } };

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

/** `query` searched on Exa's keyless MCP endpoint through `send` (fetch; a test's fake), at most `n` results. */
export async function exaSearch(query: string, n: number, { send = fetch, signal }: { send?: typeof fetch; signal?: AbortSignal } = {}): Promise<Search> {
  const deadline = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
  let session: string | undefined;
  const post = (body: Record<string, unknown>) =>
    send(EXA_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT, "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: deadline,
    });
  const refused = async (response: Response, step: string): Promise<Search | undefined> => {
    if (response.ok) return undefined;
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) return { error: `Exa's keyless search is rate-limited (429)${response.headers.get("retry-after") ? `; it says to wait ${response.headers.get("retry-after")} s` : ""}: answer without searching, or try again later` };
    if (response.status === 403) return { error: "Exa refused keyless use from this connection (403): it takes keyless searches only over IPv4, straight to its endpoint, not over IPv6 or through a proxy" };
    return { error: `Exa's MCP endpoint answered ${response.status} to ${step}` };
  };
  try {
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
    if (answer?.error) return { error: `Exa's search failed: ${String(answer.error.message ?? "no detail").slice(0, 300)}` };
    const content = Array.isArray(answer?.result?.content) ? (answer.result.content as { type?: unknown; text?: unknown }[]) : undefined;
    const said = content?.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n") ?? "";
    if (!content || answer?.result?.isError === true) return { error: `Exa's search failed: ${said.slice(0, 300) || "no answer"}` };
    const hits = said.split(/\n-{3,}\n/).flatMap((section) => hitOf(section) ?? []);
    return { provider: "exa-keyless", query, results: hits.slice(0, n) };
  } catch (error) {
    const name = (error as Error)?.name;
    return { error: name === "TimeoutError" ? "Exa's search did not answer within 60 s" : name === "AbortError" ? "the search was stopped" : `Exa's search failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
  }
}
