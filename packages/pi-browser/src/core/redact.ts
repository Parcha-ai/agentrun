// One scrubber for every text the package returns, files or logs: the exact values a host registers (run tokens),
// URL query parameters named like credentials, and the key shapes Stagehand's own redactor knows. Each rule matches
// structure (a registered value, a parameter name, a key prefix), never what a text means.

export type Redact = (text: string) => string;

const REDACTED = "[redacted]";

/** A registered value shorter than this is ignored: scrubbing a short string everywhere would destroy the text around
 *  it, and no credential is that short. */
export const MIN_REDACTED_VALUE_LENGTH = 8;

const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // Credential-bearing query parameters (a CDP signing key, an API key, a token, a JWT, a signature).
  [/([?&](?:signingKey|api_?key|(?:access_)?token|key|jwt|signature)=)[^&#\s"'<>]+/gi, `$1${REDACTED}`],
  // OpenAI-style secret keys, Browserbase live and test keys, Google API keys.
  [/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, `$1${REDACTED}`],
  [/\b(bb_(?:live|test)_[A-Za-z0-9]{4})[A-Za-z0-9_-]+/g, `$1${REDACTED}`],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, `AIza${REDACTED}`],
  // Bearer authorization values.
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
];

/** A scrubber over the built-in shapes plus `values()`, read at every call so a value registered later is covered.
 *  A value is also scrubbed in its URL-encoded form, the way it appears inside a URL. */
export function createRedactor(values: () => readonly string[] = () => []): Redact {
  return (text) => {
    let out = text;
    for (const value of values()) {
      if (typeof value !== "string" || value.length < MIN_REDACTED_VALUE_LENGTH) continue;
      for (const form of new Set([value, encodeURIComponent(value)])) out = out.split(form).join(REDACTED);
    }
    for (const [shape, replacement] of SHAPES) out = out.replace(shape, replacement);
    return out;
  };
}

/** A page URL as custody keeps and reports it (navigation, last URL, the host's session rows, notices). A credential
 *  can sit in any query value, the fragment or the userinfo whatever its name, so every query value is replaced (the
 *  names stay) and the fragment and userinfo are dropped before `redact` runs. Anything but an http(s) URL is only
 *  redacted. */
export function scrubPageUrl(raw: string, redact: Redact): string {
  let url: URL;
  try { url = new URL(raw); } catch { return redact(raw); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return redact(raw);
  const names = [...new Set(url.searchParams.keys())];
  return redact(`${url.origin}${url.pathname}${names.length ? `?${names.map((n) => `${encodeURIComponent(n)}=${REDACTED}`).join("&")}` : ""}`);
}

/** `value` with every string inside it, object keys included, passed through `redact`. */
export function redactDeep<T>(value: T, redact: Redact): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactDeep(item, redact)])) as T;
  }
  return value;
}
