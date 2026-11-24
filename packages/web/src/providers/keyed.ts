// A provider on the run's key over its HTTP API (Exa's, Firecrawl's): each request paid through the injected Pay at its
// price and never sent without one; a status in `refuseOn` stops the client for its life; a 402 is the key's credit
// spent (a quota) and a 429 a rate limit for its Retry-After, both for the run's breaker. Nothing is retried. A
// provider's own words are never passed on: a failure is said in ours, with its status and, where it gives one, its code.
import { type Fee, PaidRefused, type Pay, unmetered } from "../fees.js";
import type { Read } from "../page.js";
import { type Limit, offUntil, waitOf } from "../search.js";

/** The most bytes of one answer read: past it the answer is not read. */
export const KEYED_MAX_BYTES = 8 * 1024 * 1024;

/** A request that gave no answer this server reads, in our words, and the limit it met, if any (for the breaker). */
export type KeyedFailed = { error: string; limit?: Limit };
/** One provider on one key: `who` names it in our words, `live` is false once it refused the key, `post` is one paid
 *  request to `path` below its base. */
export type Keyed = { who: string; live(): boolean; post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> };
/** A provider's API: its name in our words, its base URL, its auth headers, its prices, its bound, the statuses that
 *  refuse the key for the client's life. */
export type KeyedSpec = { who: string; base: string; headers: Record<string, string>; feeOf: (path: string, body: unknown) => Fee | undefined; timeoutMs: number; refuseOn: readonly number[] };

export function keyedClient({ who, base, headers, feeOf, timeoutMs, refuseOn }: KeyedSpec, send: typeof fetch = fetch, pay: Pay = unmetered): Keyed {
  let refused = false;
  const root = base.replace(/\/+$/, "");
  return {
    who,
    live: () => !refused,
    async post(path, body, signal) {
      const fee = feeOf(path, body);
      if (!fee) throw new PaidRefused(`${who}'s ${path} was not sent: it has no price here`);
      return pay(fee, async () => {
        const response = await send(`${root}${path}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        });
        if (refuseOn.includes(response.status)) refused = true;
        return response;
      });
    },
  };
}

/** What a status says of the run's key: its credit spent (402), or a rate limit (429) for its Retry-After. */
export function statusLimit(response: Response): Limit | undefined {
  if (response.status === 402) return { kind: "quota" };
  const retryAfter = response.headers.get("retry-after");
  return response.status === 429 ? { kind: "rate", ...(retryAfter ? { retryAfter } : {}) } : undefined;
}

/** A provider's machine code (Exa's `tag`, Firecrawl's `code`): upper-case words joined by underscores, else none. */
export const codeOf = (said: unknown): string | undefined => (typeof said === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(said) ? said : undefined);

/** An answer's JSON, read to at most KEYED_MAX_BYTES; undefined when it runs past them or is not JSON. */
async function jsonOf(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > KEYED_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** One paid request to `client`'s `path` for a tool's `what`, read as JSON: its answer, or why there is none, in our
 *  words: no key (`keyEnv` names the variable), the key refused, the cap's refusal, a timeout, a status (its code where
 *  the provider gives one, its limit for the breaker), or an answer that is not JSON. */
export async function keyedCall(client: Keyed | null, who: string, keyEnv: string, what: "search" | "fetch", path: string, body: unknown, signal?: AbortSignal): Promise<{ json: Record<string, unknown> } | KeyedFailed> {
  if (!client) return { error: `web_${what} goes through ${who} here, and this run holds no ${who} key (${keyEnv})` };
  if (!client.live()) return { error: `${who} refused this run's key: it is not asked again in this run` };
  let response: Response;
  try {
    response = await client.post(path, body, signal);
  } catch (error) {
    if (error instanceof PaidRefused) return { error: error.message };
    const name = (error as Error)?.name;
    return { error: name === "TimeoutError" ? `${who}'s ${what} did not answer in time` : name === "AbortError" ? `${who}'s ${what} was stopped` : `${who}'s ${what} failed to connect` };
  }
  if (!response.ok) {
    const said = (await jsonOf(response)) as { tag?: unknown; code?: unknown } | undefined;
    const code = codeOf(said?.code) ?? codeOf(said?.tag);
    if (!client.live()) return { error: `${who} refused this run's key (${response.status}): it is not asked again in this run` };
    const limit = statusLimit(response);
    return { error: `${who}'s ${what} answered ${response.status}${code ? ` (${code})` : ""}`, ...(limit ? { limit } : {}) };
  }
  const json = await jsonOf(response);
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { error: `${who}'s ${what} answered nothing this server reads` };
  return { json: json as Record<string, unknown> };
}

/** A keyed provider's reads for one run's web_fetch, with the run's breaker on them: `live` is false once the key was
 *  refused, while a limit keeps it off (offUntil: a quota until the reset it names, else for the rest of the run; a wait
 *  past 15 minutes until it ends) and while a shorter rate limit's wait holds (waitOf). With no client (no key) it stays
 *  live, and each read says the run holds no key, unsent. */
export type KeyedFetch = { live(): boolean; read(url: string, signal?: AbortSignal): Promise<Read | KeyedFailed> };
export function keyedFetch(client: Keyed | null, read: (url: string, signal?: AbortSignal) => Promise<Read | KeyedFailed>, now: () => number = Date.now): KeyedFetch {
  let offTill = 0;
  let until = 0;
  return {
    live: () => (client === null || client.live()) && now() >= offTill && now() >= until,
    async read(url, signal) {
      const got = await read(url, signal);
      if ("ok" in got || !got.limit) return got;
      const at = now();
      const till = offUntil(got.limit, at);
      if (till !== undefined) offTill = Math.max(offTill, till);
      else until = Math.max(until, at + waitOf(got.limit.retryAfter, at));
      return got;
    },
  };
}

/** A setting's check, and what it must be, in words. */
export type Check = [ok: (value: unknown) => boolean, must: string];
export const oneOf = (values: readonly string[]): Check => [(value) => typeof value === "string" && values.includes(value), `one of ${values.map((one) => JSON.stringify(one)).join(", ")}`];
export const wholeIn = (min: number, max: number): Check => [(value) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max, `a whole number from ${min} to ${max}`];
export const yesNo: Check = [(value) => typeof value === "boolean", "true or false"];
export const matching = (pattern: RegExp, must: string): Check => [(value) => typeof value === "string" && pattern.test(value), must];
export const domains = (max: number): Check => [(value) => Array.isArray(value) && value.length <= max && value.every((one) => typeof one === "string" && one.trim() !== "" && one.length <= 253), `a list of at most ${max} domains`];

/** What is wrong with `settings` for `who` by `checks`, one line each: not an object, a setting it does not take, or a
 *  value its check refuses. */
export function settingsProblems(who: string, settings: unknown, checks: Readonly<Record<string, Check>>): string[] {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return [`${who}'s settings must be an object`];
  return Object.entries(settings).flatMap(([name, value]) => {
    const check = checks[name];
    if (!check) return [`${who} takes no setting ${JSON.stringify(name)} (it takes ${Object.keys(checks).join(", ")})`];
    if (value === undefined || check[0](value)) return [];
    return [`${who}'s ${name} must be ${check[1]} (it was ${String(JSON.stringify(value)).slice(0, 60)})`];
  });
}
