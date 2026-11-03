// A key a person saves (tool-keys.ts) is checked against its provider before it is kept: one authenticated call that
// costs nothing, given CHECK_MS to answer. A 401 is the provider refusing the key, and the save is refused with nothing
// kept; a 2xx is the key accepted. A 403 is the provider knowing the key and not answering this call: a key scoped away
// from it (an OpenAI restricted key without the Models permission) may still do its tools' work, so it is never refused.
// That, no such call for the provider, no answer in time, the network, or any other status keeps the key as not
// checked, saying why: an answer that does not say whether a key works never stops a save.
// Never a paid request: each call below cites the provider's pages that show it is not billed. No outcome holds the
// key: the provider's first sentence is quoted only when it holds no KEY_PIECE characters of the key in a row.
import { MONID_API } from "./monid.js";
import { isObject } from "./validate.js";

/** How long a provider has to answer a check. */
export const CHECK_MS = 5_000;
/** The fewest characters of a key in a row that keep a provider's words from being quoted. */
const KEY_PIECE = 6;
/** The most characters of a provider's words quoted. */
const QUOTE = 200;

/** What a saved key's row says of its check (GET /settings/tool-keys' `check`): accepted by its provider, or kept not
 *  checked and why. `at` is when it was checked; a key kept before this server checked keys has none. */
export type KeyCheck = { state: "accepted"; at: string } | { state: "not_checked"; reason: string; at?: string };
/** A check's outcome: a KeyCheck to keep with the key, or the provider's refusal, in its words, when it is not kept. */
export type CheckOutcome = KeyCheck | { state: "refused"; message: string };

type Call = { url: string; method?: "POST"; headers: Record<string, string>; body?: string };
const base = (set: string | undefined, fallback: string) => (set?.trim() || fallback).replace(/\/+$/, "");

/** Each provider's check, by key id (tool-keys.ts' TOOL_KEYS, and a model provider's key where the server keeps one),
 *  made with the key and the server's environment, at the base this server sends that provider's calls to. */
export const KEY_CHECKS: Record<string, (key: string, env: NodeJS.ProcessEnv) => Call> = {
  // A discover of one result, as every monid tool call starts: monid prices running an endpoint, and shows that price in
  // discover's results (https://docs.monid.ai/guide/pricing.html, https://docs.monid.ai/api/discover.html).
  monid: (key) => ({ url: `${MONID_API}/v1/discover`, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ query: "company data", limit: 1 }) }),
  // A list of the key's monitors: Parallel prices searches, extracts, decisions, task runs and a monitor's executions,
  // never a list (https://docs.parallel.ai/api-reference/monitor/list-monitors, https://docs.parallel.ai/getting-started/pricing).
  parallel: (key) => ({ url: "https://api.parallel.ai/v1/monitors?limit=1", headers: { "x-api-key": key } }),
  // A list of the key's projects: Browserbase bills a session's browser time and proxy bandwidth, and this opens no
  // session (https://docs.browserbase.com/reference/api/list-projects, https://docs.browserbase.com/account/billing/plans).
  browserbase: (key, env) => ({ url: `${base(env.BROWSERBASE_BASE_URL, "https://api.browserbase.com")}/v1/projects`, headers: { "x-bb-api-key": key } }),
  // A list of the account's models: TypeSafe prices a System One request's input tokens
  // (https://docs.typesafe.ai/api/list-models, https://docs.typesafe.ai/models).
  typesafe: (key, env) => ({ url: `${base(env.TYPESAFE_BASE_URL, "https://api.typesafe.ai")}/v1/models`, headers: { authorization: `Bearer ${key}` } }),
  // A model provider's key: its list of models, or OpenRouter's record of the key; each prices tokens, and these use none
  // (https://platform.claude.com/docs/en/api/models/list, https://platform.openai.com/docs/api-reference/models/list,
  // https://openrouter.ai/docs/api-reference/limits).
  anthropic: (key, env) => ({ url: `${base(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com")}/v1/models?limit=1`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }),
  openai: (key) => ({ url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${key}` } }),
  openrouter: (key) => ({ url: "https://openrouter.ai/api/v1/key", headers: { authorization: `Bearer ${key}` } }),
};

/** The provider's words in an answer's `text`: its JSON error's message, else plain text (never a page), its first
 *  sentence, at most QUOTE characters; empty when they hold KEY_PIECE characters of `key` in a row, or there are none. */
function quoted(text: string, key: string): string {
  let words = text.trim();
  try {
    const json: unknown = JSON.parse(words);
    const error = isObject(json) ? json.error : undefined;
    const said = isObject(json) ? [isObject(error) ? error.message : error, json.message, json.detail].find((item) => typeof item === "string") : undefined;
    words = typeof said === "string" ? said : "";
  } catch {
    if (words.startsWith("<")) words = "";
  }
  const sentence = words.replace(/\s+/g, " ").trim().split(/(?<=[.!?]) /)[0].replace(/\.$/, "").slice(0, QUOTE);
  const piece = Math.min(KEY_PIECE, key.length);
  for (let at = 0; at + piece <= key.length; at++) if (sentence.includes(key.slice(at, at + piece))) return "";
  return sentence;
}

/** `row`'s key checked against its provider through `fetcher` (undefined: a faux server with no fake for it, so no call
 *  is made), in at most `ms`, and no longer than `stop` (the server closing) lets it wait. */
export async function checkKey(row: { id: string; label: string }, key: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch | undefined | null, ms = CHECK_MS, stop?: AbortSignal): Promise<CheckOutcome> {
  const at = new Date().toISOString();
  const notChecked = (reason: string): KeyCheck => ({ state: "not_checked", reason, at });
  const check = Object.hasOwn(KEY_CHECKS, row.id) ? KEY_CHECKS[row.id] : undefined;
  if (!check) return notChecked(`${row.label} has no call that costs nothing to check a key with`);
  if (!fetcher) return notChecked(`This server runs on faux providers and has no fake ${row.label} to check the key with`);
  const { url, ...init } = check(key, env);
  let res: Response;
  try {
    res = await fetcher(url, { ...init, signal: stop ? AbortSignal.any([AbortSignal.timeout(ms), stop]) : AbortSignal.timeout(ms) });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") return notChecked(`${row.label} did not answer in ${ms / 1000} s`);
    const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
    const why = quoted(typeof cause === "string" ? cause : String((error as Error)?.message ?? error), key);
    return notChecked(`${row.label} could not be reached${why ? ` (${why})` : ""}`);
  }
  const { status } = res;
  if (status >= 200 && status < 300) {
    await res.body?.cancel().catch(() => undefined);
    return { state: "accepted", at };
  }
  // The status decides. The provider's words only add to it: quoted when its body reads in time, else not at all, so a
  // 401 whose body is cut off or stalls past the deadline still refuses the key.
  const said = quoted(await res.text().catch(() => ""), key);
  if (status === 401) return { state: "refused", message: `${row.label} refused this key (401${said ? `: ${said}` : ""})` };
  if (status === 403) return notChecked(`${row.label} would not answer the check (403${said ? `: ${said}` : ""}); the key may still work for its tools`);
  return notChecked(`${row.label} answered ${status}${said ? ` (${said})` : ""}`);
}
