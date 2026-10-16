// What a published or exported run must never hold: a credential's shape, or a machine path. One list, for every
// scanner that checks a recording, a store export or a gallery's gate; each adds its own exact values on top. It
// imports nothing, so it runs wherever a scan does.

/** The credential shapes (and machine paths) that must not appear in a published run, by name. Beyond the shapes every key
 *  has, a provider that publishes a prefix has a shape of its own here, a backstop for the moment a tool result or a page
 *  carries the key itself. */
export const FORBIDDEN: readonly (readonly [string, RegExp])[] = Object.freeze([
  ["machine path", /\/(?:home|Users)\/[A-Za-z0-9._-]+\//],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["provider secret", /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{30,}\b/],
  ["aws access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  // A signed JSON Web Token (a ChatGPT sign-in's access and id tokens are ones): a base64url JSON header and payload, each
  // starting `{"` (`eyJ`), and a signature.
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  // Browserbase (BROWSERBASE_API_KEY): its docs show a key as `bb_live_...`.
  ["browserbase api key", /\bbb_live_[A-Za-z0-9_-]{16,}/],
  ["credential url", /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ["bearer secret", /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  ["literal credential", /(?:api[_-]?key|password|access[_-]?token|auth[_-]?token|client[_-]?secret)['"]?\s*[=:]\s*['"][^'"\n]{8,}['"]/i],
] as const);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The name of the first credential shape in a text, or undefined. */
export const credentialIn = (text: string): string | undefined => FORBIDDEN.find(([, pattern]) => pattern.test(text))?.[0];

/** The name of the first credential shape in any string or key of a decoded JSON value: the raw text can hide one behind an
 *  escape (`sk-`). */
export function credentialInValue(value: unknown): string | undefined {
  if (typeof value === "string") return credentialIn(value);
  if (Array.isArray(value)) { for (const inner of value) { const found = credentialInValue(inner); if (found) return found; } return undefined; }
  if (isObject(value)) { for (const [key, inner] of Object.entries(value)) { const found = credentialIn(key) ?? credentialInValue(inner); if (found) return found; } }
  return undefined;
}
