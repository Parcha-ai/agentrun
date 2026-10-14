import { fetchedSpellings } from "./uri.js";

export type Redact = (text: string) => string;

const REDACTED = "[redacted]";

/** Scrubbing a shorter string everywhere would destroy the text around it, and no credential is that short. */
export const MIN_REDACTED_VALUE_LENGTH = 8;

const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/([?&](?:signingKey|api_?key|(?:access_)?token|key|jwt|signature)=)[^&#\s"'<>]+/gi, `$1${REDACTED}`],
  // OpenAI-style secret keys, Browserbase live and test keys, Google API keys.
  [/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, `$1${REDACTED}`],
  [/\b(bb_(?:live|test)_[A-Za-z0-9]{4})[A-Za-z0-9_-]+/g, `$1${REDACTED}`],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, `AIza${REDACTED}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
];

/** `values()` is read at every call; each value is scrubbed raw, URL-encoded fully, and in every spelling web_fetch can
 *  send it in (fetchedSpellings), longest first. */
export function createRedactor(values: () => readonly string[] = () => []): Redact {
  return (text) => {
    const forms = new Set([...values()].filter((value) => typeof value === "string" && value.length >= MIN_REDACTED_VALUE_LENGTH).flatMap((value) => [value, encodeURIComponent(value), ...fetchedSpellings(value)]));
    let out = text;
    for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join(REDACTED);
    for (const [shape, replacement] of SHAPES) out = out.replace(shape, replacement);
    return out;
  };
}

/** A credential can sit in any query value, the fragment or the userinfo, so every query value is replaced (names stay)
 *  and the fragment and userinfo are dropped before `redact` runs. A non-http(s) URL is only redacted. */
export function scrubPageUrl(raw: string, redact: Redact): string {
  let url: URL;
  try { url = new URL(raw); } catch { return redact(raw); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return redact(raw);
  const names = [...new Set(url.searchParams.keys())];
  return redact(`${url.origin}${url.pathname}${names.length ? `?${names.map((n) => `${encodeURIComponent(n)}=${REDACTED}`).join("&")}` : ""}`);
}

/** A fetch's final URL for the model: a query value or fragment stays only where the requested URL has it; userinfo never does. */
export function scrubFetchedUrl(raw: string, requested: string, redact: Redact): string {
  let url: URL, asked: URL;
  try { url = new URL(raw); } catch { return redact(raw); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return redact(raw);
  try { asked = new URL(requested); } catch { return scrubPageUrl(raw, redact); }
  const decoded = (text: string) => { try { return decodeURIComponent(text.replace(/\+/g, " ")); } catch { return text; } };
  const pairsOf = (search: string) => search.slice(1).split("&").filter(Boolean).map((pair) => {
    const at = pair.indexOf("=");
    return at < 0 ? { pair, key: pair, value: "" } : { pair, key: pair.slice(0, at), value: pair.slice(at + 1) };
  });
  const sent = new Set(pairsOf(asked.search).map(({ key, value }) => `${decoded(key)}\0${decoded(value)}`));
  const query = pairsOf(url.search).map(({ pair, key, value }) => (sent.has(`${decoded(key)}\0${decoded(value)}`) ? pair : `${key}=${REDACTED}`));
  const fragment = url.hash && url.hash === asked.hash ? url.hash : "";
  return redact(`${url.protocol}//${url.host}${url.pathname}${query.length ? `?${query.join("&")}` : ""}${fragment}`);
}

/** Every string inside `value`, object keys included, passed through `redact`. */
export function redactDeep<T>(value: T, redact: Redact): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactDeep(item, redact)])) as T;
  }
  return value;
}
