// The session vault port: what a host that keeps a signed-in browser session gives the package. UNLIKE the rest of core/host.ts, the
// state types here carry secret values (cookies, storage, a provider's context id): they live in memory, cross only this port, and
// never enter a document, a log, a tool result or a recording. The host encrypts them; the package never writes them anywhere.

/** The most a session cookie may be restored after its capture: 24 hours. A host may set a lower age, never a higher one. */
export const MAX_SESSION_COOKIE_AGE_MS = 24 * 60 * 60 * 1000;

/** The age cap a restore applies to session cookies. Absent, 24 h; above 24 h, clamped to 24 h; zero, negative or not a number, refused. */
export function clampSessionCookieAgeMs(requested?: number): number {
  if (requested === undefined) return MAX_SESSION_COOKIE_AGE_MS;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) throw new RangeError("the session-cookie age cap is a positive number of milliseconds");
  return Math.min(requested, MAX_SESSION_COOKIE_AGE_MS);
}

export type VaultCookie = {
  name: string; value: string; domain: string; path: string;
  /** Seconds since the epoch; absent means a SESSION cookie. */
  expires?: number;
  httpOnly: boolean; secure: boolean; sameSite?: "Strict" | "Lax" | "None";
};

export type CapturedState =
  | {
      kind: "cdp"; capturedAt: string;
      /** Only cookies the allowed origins would be sent (see `cookieKept`). Partitioned cookies are not kept. */
      cookies: VaultCookie[];
      localStorage: Record<string, Record<string, string>>;
    }
  /** `origins`: the origins the context was captured for. A context holds a whole browser profile, so it is restored only for a request that covers EVERY one of them (`coversEveryOrigin`); one that records none is refused. */
  | { kind: "provider-context"; capturedAt: string; provider: "browserbase" | "kernel"; contextId: string; origins?: string[] };

/** Whether `requested` includes every origin in `saved` (as scheme://host[:port], any order): a provider context is all-or-nothing, so a request for some of its origins would bring back the others' sign-ins. */
export function coversEveryOrigin(requested: readonly string[], saved: readonly string[] | undefined): boolean {
  if (!saved || saved.length === 0) return false;
  const origin = (value: string) => { try { return new URL(value).origin; } catch { return null; } };
  const have = new Set(requested.map(origin));
  return saved.every((value) => { const o = origin(value); return o !== null && have.has(o); });
}

export interface SessionVaultPort {
  /** At release and at the end of a handoff, and, for a context a new session made, right after the create (so a restart still finds it). The host supplied the origins; nothing outside them was captured.
   *  A capture has a deadline (20 s) after which nothing more is read or written, but a write already handed to this port cannot be recalled: ignore one whose `capturedAt` is older than the one you hold. */
  capture(input: { sessionKey: string; origins: string[]; state: CapturedState }): Promise<void>;
  /** At create, before the driver attaches. null: nothing kept, or all of it expired. */
  restore(input: { sessionKey: string; origins: string[] }): Promise<CapturedState | null>;
  /** Crypto-shred: the item's key is destroyed. The package never calls this itself; the host does, on a revoke. */
  forget(sessionKey: string): Promise<void>;
}

/** The host's choice, per conversation: which saved sign-in and which origins. Never the model's. Not a secret. */
export type VaultTarget = { sessionKey: string; origins: string[] };

const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** The host's allowed origins, each `scheme://host[:port]` of http or https, normalised and de-duplicated; anything else is refused. */
export function vaultOrigins(origins: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of origins) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new RangeError(`not an origin: ${String(raw).slice(0, 80)}`); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null" || url.origin !== raw.replace(/\/$/, "")) throw new RangeError(`an allowed origin is scheme://host[:port] of http or https: ${String(raw).slice(0, 80)}`);
    out.add(url.origin);
  }
  if (out.size === 0) throw new RangeError("a vault target needs at least one origin");
  return [...out];
}
export function vaultTarget(target: VaultTarget): { sessionKey: string; origins: string[] } {
  if (!SESSION_KEY.test(target.sessionKey)) throw new RangeError("a vault session key is 1 to 128 characters of letters, digits and . _ : -");
  return { sessionKey: target.sessionKey, origins: vaultOrigins(target.origins) };
}

const loopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

/** Whether a browser cookie belongs to the allowed origins: it would be SENT to at least one of them, by domain and secure flag (any path
 *  on an origin is the origin's). A host-only cookie matches its own host; a domain cookie (leading dot) matches the host and every host
 *  under it; a domain with no dot inside it (a public suffix) matches only a host equal to it; a secure cookie needs an https origin (a
 *  loopback host counts); a partitioned cookie is not kept. */
export function cookieKept(cookie: { domain: string; secure?: boolean; partitionKey?: unknown }, origins: readonly string[]): boolean {
  if (cookie.partitionKey) return false;
  const domain = cookie.domain.toLowerCase();
  const domainCookie = domain.startsWith(".");
  const base = domain.replace(/^\./, "");
  if (!base) return false;
  return origins.some((origin) => {
    let url: URL;
    try { url = new URL(origin); } catch { return false; }
    const host = url.hostname.toLowerCase();
    const hostMatches = domainCookie ? host === base || (base.includes(".") && host.endsWith(`.${base}`)) : host === base;
    if (!hostMatches) return false;
    return !(cookie.secure && url.protocol !== "https:" && !loopback(host));
  });
}
