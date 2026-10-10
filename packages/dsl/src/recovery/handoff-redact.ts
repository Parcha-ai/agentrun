// Credentials, not substrings. A value is redacted when its key names a credential or when the value has a credential's
// shape. Key names are compared as words (split on `_`, `-`, spaces and camelCase, lowercased): a key names a credential
// when any of its words is a credential word, or any two adjacent words are a credential pair. `input_tokens` is the
// words [input, tokens]; `tokens` is a count's word, never the credential word `token`, so counts and limits survive
// while `access_token`, `token_value` and `api_key_id` do not.

/** Words that name a credential wherever they stand in a key. */
const CREDENTIAL_WORDS = new Set(["token", "secret", "password", "passwd", "passphrase", "authorization", "cookie", "credential", "credentials", "apikey"]);
/** Adjacent word pairs that name a credential: `api_key`, `X-Api-Key`, `OPENAI_API_KEY`, `private_key`, `aws_secret_access_key`. */
const CREDENTIAL_PAIRS = new Set(["api key", "private key", "secret key", "access key", "master key", "signing key", "session key", "auth key"]);

const keyWords = (key: string): string[] => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Whether a key names a credential, by the explicit lists above. */
export function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  return words.some((word, index) => CREDENTIAL_WORDS.has(word) || (index > 0 && CREDENTIAL_PAIRS.has(`${words[index - 1]} ${word}`)));
}

/** Credential-shaped substrings of any text, each replaced by `<redacted>`: an HTTP `Bearer` credential, an environment
 *  assignment (`NAME=value`) whose name is a credential key, a URL's userinfo, a JWT, and the prefixed keys providers
 *  issue (`sk-`, GitHub `gh?_` and `github_pat_`, Slack `xox?-`, AWS `AKIA`, Google `AIza`). A SHA-256 or any other
 *  unprefixed digest is not a credential. */
export function redactCredentialText(value: unknown): string {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/\b([A-Z][A-Z0-9_]*)=(\S+)/g, (whole, name: string) => (isCredentialKey(name) ? `${name}=<redacted>` : whole))
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]+(?::[^\s/?#@]*)?@/gi, "$1<redacted>@")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|crsr_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g, "<redacted>");
}

/** A value with every credential-named key's value and every credential-shaped string redacted, objects and arrays walked. */
export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = isCredentialKey(key) ? "<redacted>" : redactSensitiveValue(item);
    return out;
  }
  return value;
}

/** Every string that reaches a continuation's first turn passes here: values redacted object-aware first, then the
 *  finished text once more by pattern, and an email address by its form. */
export const redactText = (text: string): string => String(redactSensitiveValue(text)).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted email>");
