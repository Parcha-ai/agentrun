// A provider on the run's key over its HTTP API (Exa's, Firecrawl's): each request paid through the injected Pay at its
// price and never sent without one; a status in `refuseOn` stops the client for its life; a 402 is the key's credit
// spent (a quota) and a 429 a rate limit for its Retry-After, both for the run's breaker. A request on a stopped call is
// never asked of the Pay, and one that failed before it left (paidSend) is settled at $0. Nothing is retried. A
// provider's own words are never passed on: a failure is said in ours, with its status and, where it gives one, its code.
import { type Fee, PaidRefused, type Pay, unmetered, unsentAnswer } from "../fees.js";
import { cutAt, withoutUserinfo } from "../page.js";
import { type Failed, failed, keyWide, type Limit } from "../search.js";

/** The most bytes of one answer read: past it the answer is not read. */
export const KEYED_MAX_BYTES = 8 * 1024 * 1024;

/** A request that gave no answer this server reads, typed, and the limit it met, if any (for the breaker). */
export type KeyedFailed = Failed;
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
      return paidSend(pay, fee, signal, async () => {
        const response = await send(`${root}${path}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
          // It carries the key: a redirect is an error, never followed to an address the key was not meant for.
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        });
        if (refuseOn.includes(response.status)) refused = true;
        return response;
      });
    },
  };
}

/** The codes of a fetch's failure (the cause of undici's TypeError "fetch failed") from before its request was written:
 *  the host's name not resolved, the host or its network not reached, the connection refused or not made within
 *  undici's connect bound, the TLS handshake refusing the host's certificate. A request failing with one never reached
 *  the provider. */
const UNSENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"]);
/** Node's TLS codes (ERR_TLS_*) that can come once a connection is up, after a request may have left: not unsent. */
const TLS_LATER = new Set(["ERR_TLS_RENEGOTIATION_DISABLED", "ERR_TLS_SESSION_ATTACK"]);

/** Why `error`, thrown by a paid request's send, is one that never left this process, or undefined when it may have
 *  left (and may be billed): `stoppedFirst`, the call's signal stopped when the send started ("stopped"), or a fetch
 *  that failed connecting (its cause's code, UNSENT_CODES, a certificate's CERT_* or a handshake's ERR_TLS_*). Anything
 *  else may have reached the provider: a reset socket (ECONNRESET, UND_ERR_SOCKET), a timeout or a stop after the send
 *  started, a body that broke. */
export function unsentWhy(error: unknown, stoppedFirst: boolean): string | undefined {
  if (stoppedFirst) return "stopped";
  const thrown = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null | undefined;
  if (thrown?.name !== "TypeError" || thrown.message !== "fetch failed") return undefined;
  const code = thrown.cause?.code;
  if (typeof code !== "string") return undefined;
  return UNSENT_CODES.has(code) || code.startsWith("CERT_") || (code.startsWith("ERR_TLS_") && !TLS_LATER.has(code)) ? code : undefined;
}

/** `send`, one paid request at `fee`, through `pay`: on a signal already stopped, never asked of `pay` (nothing held),
 *  the stop's own reason thrown as fetch throws it; one whose send failed before it left (unsentWhy) answered to `pay`
 *  as unsentAnswer, a 4xx the cap settles at $0, and then thrown as it was, marked `unsent`. Every other failure is
 *  thrown inside `pay`, which books it at its fee. */
export async function paidSend(pay: Pay, fee: Fee, signal: AbortSignal | undefined, send: () => Promise<Response>): Promise<Response> {
  if (signal?.aborted) throw signal.reason;
  let unsent: { error: unknown } | undefined;
  const answer = await pay(fee, async () => {
    const stoppedFirst = signal?.aborted === true;
    try {
      return await send();
    } catch (error) {
      const why = unsentWhy(error, stoppedFirst);
      if (why === undefined) throw error;
      unsent = { error };
      return unsentAnswer(why);
    }
  });
  if (unsent) {
    const { error } = unsent;
    // Marked where it can be: a frozen or sealed error is thrown as it was, never replaced by the marking's own failure.
    if (error !== null && typeof error === "object") {
      try {
        Object.assign(error, { unsent: true });
      } catch {}
    }
    throw error;
  }
  return answer;
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

/** How a provider names a thrown failure: `who` and `what` (its name, the tool), the caller's `signal`, `read` where it
 *  broke while the answer was read, and the provider's own words where it keeps them: `timeout` (with its `timeoutCode`)
 *  for a bound it names, `stopped`, and `failedWith`, the words around what the error said. */
export type ThrownSay = { who: string; what: string; signal?: AbortSignal | undefined; read?: boolean; timeout?: string; timeoutCode?: string; stopped?: string; failedWith?: (said: string) => string };
/** The most of what a thrown error said that a failure quotes. */
const THROWN_SAID_MAX = 300;

/** `error`, thrown by a provider's request, typed one way for every provider, by the caller's signal's reason where it
 *  stopped (a run stops with a reason of its own, which the request fails with), else by the error: a TimeoutError is
 *  the bound running out (TIMEOUT); an AbortError, or the caller's signal stopped, a stop (STOPPED); anything else
 *  CONNECT, what it said with no URL's user name or password, cut at THROWN_SAID_MAX ("answer broke off" where it broke
 *  while the answer was read). A provider without words of its own says "<who>'s <what> ...". */
export function thrownFailure(error: unknown, { who, what, signal, read = false, timeout, timeoutCode = "TIMEOUT", stopped, failedWith }: ThrownSay): Failed {
  const name = ((signal?.aborted ? signal.reason : error) as Error | null | undefined)?.name;
  if (name === "TimeoutError") return failed("infra", timeoutCode, timeout ?? `${who}'s ${what} did not answer in time`);
  if (name === "AbortError" || signal?.aborted) return failed("infra", "STOPPED", stopped ?? `${who}'s ${what} was stopped`);
  const said = cutAt(withoutUserinfo(String((error as Error | null | undefined)?.message ?? error)), THROWN_SAID_MAX);
  return failed("infra", "CONNECT", failedWith ? failedWith(said) : read ? `${who}'s ${what} answer broke off` : `${who}'s ${what} failed to connect`);
}

/** One paid request to `client`'s `path` for a tool's `what`, read as JSON: its answer, or why there is none, in our
 *  words: no key (`keyEnv` names the variable), the key refused, the cap's refusal, a timeout, a status (its code where
 *  the provider gives one, its limit for the breaker), or an answer that is not JSON. */
export async function keyedCall(client: Keyed | null, who: string, keyEnv: string, what: "search" | "fetch", path: string, body: unknown, signal?: AbortSignal): Promise<{ json: Record<string, unknown> } | KeyedFailed> {
  if (!client) return failed("refused", "NO_KEY", `web_${what} goes through ${who} here, and this run holds no ${who} key (${keyEnv})`);
  if (!client.live()) return failed("refused", "KEY_REFUSED", `${who} refused this run's key: it is not asked again in this run`);
  // A request that failed, or an answer whose body broke after its headers came: typed by why (thrownFailure), never
  // thrown, so the receipt keeps the turn and the order goes on.
  const unanswered = (error: unknown, read: boolean) => thrownFailure(error, { who, what, signal, read });
  let response: Response;
  try {
    response = await client.post(path, body, signal);
  } catch (error) {
    if (error instanceof PaidRefused) return failed("refused", "CAP_REFUSED", error.message);
    return unanswered(error, false);
  }
  if (!response.ok) {
    // The status says what it is; a body that broke only loses the provider's code.
    const said = (await jsonOf(response).catch(() => undefined)) as { tag?: unknown; code?: unknown } | undefined;
    const code = codeOf(said?.code) ?? codeOf(said?.tag);
    if (!client.live()) return failed("refused", code ?? "KEY_REFUSED", `${who} refused this run's key (${response.status}): it is not asked again in this run`);
    const limit = statusLimit(response);
    const kind = limit ? limit.kind : response.status >= 500 ? "infra" : "error";
    const failure = failed(kind, code ?? `HTTP_${response.status}`, `${who}'s ${what} answered ${response.status}${code ? ` (${code})` : ""}`, limit);
    // A 402 is the key's credit spent, for both tools.
    return response.status === 402 ? keyWide(failure) : failure;
  }
  let json: unknown;
  try {
    json = await jsonOf(response);
  } catch (error) {
    return unanswered(error, true);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return failed("error", "UNREADABLE", `${who}'s ${what} answered nothing this server reads`);
  return { json: json as Record<string, unknown> };
}

/** A setting's check, and what it must be, in words. */
export type Check = [ok: (value: unknown) => boolean, must: string];
export const oneOf = (values: readonly string[]): Check => [(value) => typeof value === "string" && values.includes(value), `one of ${values.map((one) => JSON.stringify(one)).join(", ")}`];
export const wholeIn = (min: number, max: number): Check => [(value) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max, `a whole number from ${min} to ${max}`];
export const yesNo: Check = [(value) => typeof value === "boolean", "true or false"];
export const matching = (pattern: RegExp, must: string): Check => [(value) => typeof value === "string" && pattern.test(value), must];
export const domains = (max: number): Check => [(value) => Array.isArray(value) && value.length <= max && value.every((one) => typeof one === "string" && one.trim() !== "" && one.length <= 253), `a list of at most ${max} domains`];

/** A refused value's kind in words, for a problem line that names it without echoing it. */
export const kindOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "a list" : typeof value === "object" ? "an object" : `a ${typeof value}`;

/** What is wrong with `settings` for `who` by `checks`, one line each: not an object, a setting it does not take, or a
 *  value its check refuses, named by its kind and never echoed (a key pasted into the wrong setting stays out of it). */
export function settingsProblems(who: string, settings: unknown, checks: Readonly<Record<string, Check>>): string[] {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return [`${who}'s settings must be an object`];
  return Object.entries(settings).flatMap(([name, value]) => {
    // Its own checks alone: a setting named constructor or __proto__ is not Object's member.
    const check = Object.hasOwn(checks, name) ? checks[name] : undefined;
    if (!check) return [`${who} takes no setting ${JSON.stringify(name)} (it takes ${Object.keys(checks).join(", ")})`];
    if (value === undefined || check[0](value)) return [];
    return [`${who}'s ${name} must be ${check[1]} (it was ${kindOf(value)})`];
  });
}
