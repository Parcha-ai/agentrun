// The MCP client the keyless web backends share (firecrawl-keyless.ts, exa-keyless.ts): one tool call is one exchange
// over MCP's streamable HTTP transport. `initialize` (its session id, when the server names one), then
// `notifications/initialized`, then `tools/call`, each request carrying the session id only where one came back. An
// answer is JSON or an event stream's `data:` lines, and no more than 1 MiB of one is read. No key and no header beyond
// the transport's own is sent. What a refusal means (a free limit, a connection refused) is each backend's to read.
/** The MCP revision this client speaks; the server answers the one it takes. */
export const PROTOCOL = "2025-06-18";
const ACCEPT = "application/json, text/event-stream";
/** The most of an answer read: a search's text is a few kilobytes, a page's markdown more; past this the rest is never
 *  read. */
const MAX_BYTES = 1 << 20;

/** What a free web search answers when its free limit holds, in our words: a backend's own (a link to sign up, a key in
 *  its MCP URL) mean nothing to a person here, so they are never passed on. */
export const RATE_LIMITED = "Free web search is rate-limited right now. Try again in a minute; add the free Parallel Search server in Settings → MCP servers and grant the agent its web_search; or add a Parallel key in Settings → API Keys to search with a key.";

type Rpc = { result?: Record<string, unknown>; error?: { message?: unknown } };

/** One tool call's outcome: `status`, a non-2xx answer to `step` (with the seconds its Retry-After named); `error`, a
 *  JSON-RPC error's message, or that the server answered no initialize; else the call's `result` (undefined: no answer
 *  to the call came). */
export type Called = { status: number; retryAfterS?: number; step: "initialize" | "the call" } | { error: string; rpc: boolean } | { result: Record<string, unknown> | undefined };

/** The seconds a Retry-After names, as seconds or a date; undefined when it names none. */
export function retryAfterOf(response: Response): number | undefined {
  const said = response.headers.get("retry-after")?.trim();
  if (!said) return undefined;
  if (/^\d+$/.test(said)) return Number(said);
  const at = Date.parse(said);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** `ms` of waiting that `signal` ends, rejecting with its reason. */
export const sleep = (ms: number, signal: AbortSignal) =>
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

/** A tool result's text blocks, joined by lines; empty when it has none. */
export const textBlocks = (result: Record<string, unknown> | undefined): string =>
  (Array.isArray(result?.content) ? (result.content as { type?: unknown; text?: unknown }[]) : []).flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");

/** The tool `name` called with `args` on the MCP server at `endpoint` through `dial`, each request ended by `deadline`:
 *  one exchange (initialize, notifications/initialized, tools/call). A failure to reach the server throws. */
export async function callTool(endpoint: string, dial: typeof fetch, deadline: AbortSignal, name: string, args: Record<string, unknown>): Promise<Called> {
  let session: string | undefined;
  const post = (body: Record<string, unknown>) =>
    dial(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT, "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: deadline,
    });
  const refused = async (response: Response, step: "initialize" | "the call"): Promise<Called | undefined> => {
    if (response.ok) return undefined;
    await response.body?.cancel().catch(() => undefined);
    const retryAfterS = retryAfterOf(response);
    return { status: response.status, step, ...(retryAfterS === undefined ? {} : { retryAfterS }) };
  };
  const opened = await post({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "agentrun-serve", version: "1" } } });
  const failed = await refused(opened, "initialize");
  if (failed) return failed;
  session = opened.headers.get("mcp-session-id") ?? undefined;
  if (!(await answerOf(opened, 1))?.result) return { error: "", rpc: false };
  const ready = await post({ method: "notifications/initialized" });
  await ready.body?.cancel().catch(() => undefined);
  const called = await post({ id: 2, method: "tools/call", params: { name, arguments: args } });
  const late = await refused(called, "the call");
  if (late) return late;
  const answer = await answerOf(called, 2);
  if (answer?.error) return { error: typeof answer.error.message === "string" ? answer.error.message : "", rpc: true };
  return { result: answer?.result };
}
