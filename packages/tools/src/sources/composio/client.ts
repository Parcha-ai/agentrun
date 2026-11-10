// One request to Composio's API (v3.1, https://docs.composio.dev/reference/api-reference, read 2026-11-10), shared by the
// actions (index.ts), the connection (connect.ts) and Composio's triggers. The key goes as x-api-key, from the kernel's
// credential, to Composio's origin alone: a redirect is never followed, the request is bounded and aborts with the call,
// and the key is cut out of any text that comes back. Every failure is an answer in words with its refusal code, never a
// throw.
import type { Ctx, RefusalCode } from "./protocol-draft.ts";

/** Composio's API: the one origin its key and its calls go to. */
export const COMPOSIO_API = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_ORIGIN = new URL(COMPOSIO_API).origin;
/** The header Composio reads its key from. */
export const KEY_HEADER = "x-api-key";
/** How long a listing, a check or a connection's call may take; an action's execution gets EXECUTE_MS. */
export const READ_MS = 15_000;
export const EXECUTE_MS = 120_000;
/** The most of an answer read: past it the answer is refused, never parsed in part. */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

export type Answer =
  | { ok: true; status: number; json: unknown }
  | { ok: false; refusal: RefusalCode; status?: number; words: string; /** The request left: Composio may have acted on it. */ sent?: true };

/** `text` with each secret's every occurrence cut out. */
export function scrubbed(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Composio's own words for a failure (its `error.message`, else its `error` text), or none. */
function wordsOf(json: unknown): string | undefined {
  if (!isObject(json)) return undefined;
  const error = json.error;
  if (isObject(error) && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  return typeof json.message === "string" ? json.message : undefined;
}

/** What a status Composio answered means, for a request about a connected account (`account`) or not. */
export function refusalOf(status: number, { account = false }: { account?: boolean } = {}): RefusalCode {
  if (status === 401 || status === 403) return "key_refused";
  if (status === 402) return "quota_exhausted";
  if (status === 404) return account ? "needs_connection" : "upstream_error";
  if (status === 408) return "timeout";
  if (status === 410) return "unsupported";
  if (status === 422) return account ? "connection_expired" : "upstream_error";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

/** One request to `path` under COMPOSIO_API: `query` in its URL, `body` as JSON. `account`: the request is about a
 *  connected account, so a 404 is a connection that is not there and a 422 one in a state it can't be used in. */
export async function composioCall(
  ctx: Ctx,
  method: "GET" | "POST" | "DELETE",
  path: string,
  { query, body, ms = READ_MS, account = false }: { query?: Record<string, string | undefined>; body?: unknown; ms?: number; account?: boolean } = {},
): Promise<Answer> {
  if (!ctx.credential) return { ok: false, refusal: "key_refused", words: "No Composio key is saved here: save one in Settings, then try again." };
  const [name, key] = ctx.credential.header(KEY_HEADER);
  const url = new URL(`${COMPOSIO_API}${path}`);
  for (const [field, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(field, value);
  // The path is ours; this holds even so: the key goes to Composio's origin and nowhere else.
  if (url.origin !== COMPOSIO_ORIGIN) return { ok: false, refusal: "blocked_address", words: `Composio's key goes only to ${COMPOSIO_ORIGIN}; nothing was sent.` };
  if (ctx.signal.aborted) return { ok: false, refusal: "stopped", words: "The call was stopped before it was sent." };
  const deadline = AbortSignal.timeout(ms);
  const signal = AbortSignal.any([ctx.signal, deadline]);
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method,
      redirect: "manual",
      headers: { [name]: key, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error) {
    if (ctx.signal.aborted) return { ok: false, refusal: "stopped", sent: true, words: "The call was stopped while Composio was asked." };
    if (deadline.aborted) return { ok: false, refusal: "timeout", sent: true, words: `Composio did not answer in ${Math.round(ms / 1000)} s.` };
    return { ok: false, refusal: "upstream_error", sent: true, words: scrubbed(`Composio could not be reached (${String((error as Error)?.message ?? error).slice(0, 200)}).`, [key]) };
  }
  // A redirect is never followed: the key would go with it wherever it points.
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, refusal: "blocked_address", status: res.status, sent: true, words: `Composio answered HTTP ${res.status}, a redirect, which is never followed; nothing more was sent.` };
  }
  let text: string;
  try {
    text = await bounded(res, signal);
  } catch (error) {
    if (ctx.signal.aborted) return { ok: false, refusal: "stopped", sent: true, words: "The call was stopped while Composio answered." };
    if (deadline.aborted) return { ok: false, refusal: "timeout", sent: true, words: `Composio's answer did not finish in ${Math.round(ms / 1000)} s.` };
    return { ok: false, refusal: "upstream_error", status: res.status, sent: true, words: scrubbed(String((error as Error)?.message ?? error).slice(0, 200), [key]) };
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.ok) return { ok: true, status: res.status, json };
  const said = wordsOf(json);
  return { ok: false, refusal: refusalOf(res.status, { account }), status: res.status, sent: true, words: scrubbed(`Composio answered HTTP ${res.status}${said ? `: ${said.slice(0, 500)}` : ""}.`, [key]) };
}

/** The answer's body as text, refused past MAX_ANSWER_BYTES. */
async function bounded(res: Response, signal: AbortSignal): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER_BYTES) {
        stop();
        throw new Error(`Composio's answer is over ${MAX_ANSWER_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (signal.aborted) throw new Error("stopped");
  return new TextDecoder().decode(Buffer.concat(chunks));
}
