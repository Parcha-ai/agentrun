// The MCP adapter's custody: what the owner's settings say, which headers a credential becomes, the one fetch every
// request goes through, and the scrub. Ported from serve's gateway and probe (src/mcp-gateway.ts guarded and scrub,
// src/mcp-probe.ts capped): no redirect is ever followed, a credential goes only to the toolkit's bound origin, an answer
// is read to a cap, and every credential value a call took is cut from whatever the server says back.
import { ADDRESS_REFUSED, type Credential, type Ctx, type ScrubbingCredential } from "./protocol-draft.js";

/** The settings keys of one saved MCP server (one toolkit), as the kernel hands them in `ctx.settings`:
 *  - `url`: the server's Streamable HTTP endpoint (https, or http on loopback); its origin is where a credential may go.
 *  - `auth`: none | bearer | headers | oauth | github_app (default none).
 *  - `headers`: for auth headers or github_app, the names the credential is sent in, comma-separated, lowercase.
 *  - `price.<tool>`: the owner's price for one call of that tool, in USD, a decimal number 0 or more.
 *  - `name`: the server's name, when the kernel asks for the toolkit list. */
export const SETTING = { url: "url", auth: "auth", headers: "headers", price: "price.", name: "name" } as const;
export const AUTH_TYPES = ["none", "bearer", "headers", "oauth", "github_app"] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** One saved server's settings, read. */
export type ServerSettings = { url: URL; auth: AuthType; headerNames: string[]; prices: Record<string, number>; name?: string };

/** A settings value that does not read: the words say which, never a value. */
export class SettingsInvalid extends Error {
  override name = "SettingsInvalid";
}

const LOOPBACK = (host: string) => host === "localhost" || host === "[::1]" || /^127(?:[.]\d{1,3}){3}$/.test(host);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** `settings` read as one server's: its URL, auth, the header names its credential goes in, and its prices. */
export function settingsOf(settings: Readonly<Record<string, string>>): ServerSettings {
  const text = settings[SETTING.url];
  const url = typeof text === "string" ? URL.parse(text) : null;
  if (!url) throw new SettingsInvalid("the server's url setting is missing or not a URL");
  if (url.username || url.password) throw new SettingsInvalid("the server's url holds a user or password");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK(url.hostname))) throw new SettingsInvalid("the server's url is https, or http on loopback");
  url.hash = "";
  const auth = (settings[SETTING.auth] ?? "none") as AuthType;
  if (!AUTH_TYPES.includes(auth)) throw new SettingsInvalid(`the server's auth setting is one of ${AUTH_TYPES.join(", ")}`);
  const headerNames = (settings[SETTING.headers] ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (headerNames.some((name) => !HEADER_NAME.test(name))) throw new SettingsInvalid("the server's headers setting names a header that is not one");
  if ((auth === "headers") && !headerNames.length) throw new SettingsInvalid("auth headers names the headers its credential is sent in (the headers setting)");
  const prices: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(SETTING.price)) continue;
    const usd = Number(value);
    if (value.trim() === "" || !Number.isFinite(usd) || usd < 0) throw new SettingsInvalid(`${key} is a price in USD a call, 0 or more`);
    prices[key.slice(SETTING.price.length)] = usd;
  }
  return { url, auth, headerNames, prices, ...(settings[SETTING.name] ? { name: settings[SETTING.name] } : {}) };
}

/** The headers a call sends for `server`'s auth, read from the credential now (each request reads it again, so a token the
 *  kernel refreshed meanwhile is the one sent). None for auth none. A credential missing where one is needed throws. */
export function credentialHeaders(server: ServerSettings, credential: Credential | undefined): [string, string][] {
  if (server.auth === "none") return [];
  if (!credential) throw new NoCredential(server.auth);
  const named = server.headerNames.filter((name) => name !== "authorization").map((name) => credential.header(name));
  if (server.auth === "headers") return [...named, ...(server.headerNames.includes("authorization") ? [credential.header("authorization")] : [])];
  return [...named, credential.header("authorization", "Bearer")];
}

/** A call or listing for a server whose auth needs a credential, handed none: nothing is sent. */
export class NoCredential extends Error {
  override name = "NoCredential";
  constructor(readonly auth: AuthType) {
    super(auth === "oauth" ? "the server signs in with OAuth and no sign-in was handed for it" : "the server takes a credential and none was handed for it");
  }
}

/** `text` with every value in `values` cut out, whole and as its bare token (a one-word scheme such as `Bearer ` taken
 *  off): a server that echoes a header, or only its token, never shows it. Values under 8 characters are left, as serve's
 *  gateway leaves them (a short value would cut ordinary words). Then the credential's own scrub, when it has one. */
export function scrubWith(values: Iterable<string>, credential: Credential | undefined): (text: string) => string {
  const own = (credential as ScrubbingCredential | undefined)?.scrub?.bind(credential);
  return (text: string) => {
    const cut = [...values].flatMap((value) => [value, value.replace(/^[A-Za-z][A-Za-z0-9_-]*\s+(?=\S+$)/, "")]).sort((a, b) => b.length - a.length).reduce((out, value) => (value.length >= 8 ? out.split(value).join("[redacted]") : out), text);
    return own ? own(cut) : cut;
  };
}

/** The most of one answer read (serve's gateway MAX_RESPONSE and probe MAX_RESPONSE_BYTES). */
export const MAX_RESPONSE = 4 * 1024 * 1024;

/** What one call's fetch saw, for telling failures apart: the SDK's errors do not say which status refused it. */
export type Seen = { last?: number; statuses?: number[]; redirect?: { status: number; location: string | null }; offOrigin?: string; refusedAddress?: true; overflow?: true; sentCall?: true };

/** Why a request was not sent: its URL is not the bound origin, or it answered a redirect. */
export class Unsent extends Error {
  override name = "Unsent";
}

/** The one fetch a call or listing sends with: the kernel's `ctx.fetch`, to `boundTo` alone, with the credential's headers
 *  read at each request (each value kept in `values` for the scrub before it leaves), never following a redirect, its
 *  answer read to MAX_RESPONSE. `seen` records the status, a redirect, a request off the origin, and whether a tools/call
 *  left. */
export function guardedFetch(ctx: Pick<Ctx, "fetch">, boundTo: string, headers: () => [string, string][], values: Set<string>, seen: Seen): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = URL.parse(input instanceof Request ? input.url : String(input));
    if (!target || target.origin !== boundTo) {
      seen.offOrigin = target?.origin ?? "an address that does not read";
      throw new Unsent(`a request to ${seen.offOrigin} was refused unsent: the credential is bound to ${boundTo}`);
    }
    const sent = new Headers(init.headers);
    for (const [name, value] of headers()) {
      values.add(value);
      sent.set(name, value);
    }
    if (typeof init.body === "string" && callsTool(init.body)) seen.sentCall = true;
    let response: Response;
    try {
      response = await ctx.fetch(input, { ...init, headers: sent, redirect: "manual" });
    } catch (error) {
      if (addressRefused(error)) {
        seen.refusedAddress = true;
        // Refused by the kernel's fetch before it left: no call went.
        if (typeof init.body === "string" && callsTool(init.body)) delete seen.sentCall;
      }
      throw error;
    }
    seen.last = response.status;
    (seen.statuses ??= []).push(response.status);
    if (response.status >= 300 && response.status < 400) {
      seen.redirect = { status: response.status, location: response.headers.get("location") };
      await response.body?.cancel().catch(() => undefined);
      throw new Unsent(`it answered a redirect (HTTP ${response.status}), which is never followed`);
    }
    if (!response.body || [101, 204, 205, 304].includes(response.status)) return response;
    let read = 0;
    const capped = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        read += chunk.byteLength;
        if (read > MAX_RESPONSE) {
          seen.overflow = true;
          out.error(new Error(`its answer is longer than ${MAX_RESPONSE} bytes`));
        } else out.enqueue(chunk);
      },
    }));
    return new Response(capped, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

/** Whether a JSON-RPC body (one message or a batch) is a tools/call. */
function callsTool(body: string): boolean {
  try {
    return [JSON.parse(body)].flat().some((message: unknown) => (message as { method?: unknown })?.method === "tools/call");
  } catch {
    return false;
  }
}

/** Whether the kernel's fetch refused the address (protocol-draft ADDRESS_REFUSED, on the error or down its causes). */
export function addressRefused(error: unknown): boolean {
  for (let at = error, depth = 0; at && typeof at === "object" && depth < 8; at = (at as { cause?: unknown }).cause, depth++) {
    if ((at as { code?: unknown }).code === ADDRESS_REFUSED || (at as { name?: unknown }).name === "AddressRefused") return true;
  }
  return false;
}

/** Whether an error is a timeout (the SDK's request timeout, a deadline's abort). */
export function timedOut(error: unknown): boolean {
  for (let at = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) {
    if (at.name === "TimeoutError" || /timed? ?out/i.test(at.message) || (at as { code?: unknown }).code === -32001) return true;
  }
  return false;
}

/** `work` until `signal` aborts: an abort answers at once, whatever the work is waiting on. */
export function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
