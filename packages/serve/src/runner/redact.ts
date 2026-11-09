// The runner's one redactor (the secrets decision's rule three: no log, journal entry or export carries a secret value).
// A thrown error's text reaches a run's row and its journal end (runner.ts endRun and a loop it cannot make, the adapter
// loop's failed end), the runner's events, and the model route's error text that pi records. Each passes through the one
// function made here, which puts "[redacted]" in place of every secret value the runner holds, in every form a value
// can take in text (key-refusal.ts redactedAnswer: as written, JSON-escaped, base64, hex and percent-encoded).
import { redactedAnswer } from "../key-refusal.js";
import { MIN_SECRET } from "../learn/secrets.js";
import { hostSecrets, SECRET_NAMES } from "../secrets.js";

/** Text with every secret value the redactor holds cut out. */
export type Redact = (text: string) => string;

/** What leaves text as it is: a runner given no secrets to cut. */
export const keepText: Redact = (text) => text;

/** Every secret value `env` holds for the runner: the server's held secrets, the MCP credentials and every key-, token-,
 *  secret- or password-named value (secrets.ts hostSecrets), and the value `env` itself gives each launcher name (a
 *  runner's key comes in its env, which hostSecrets reads only for names off the launcher's list), with any `extra` a
 *  caller holds. One shorter than MIN_SECRET, whitespace aside, matches too much text by chance and is left out. */
export function runnerSecrets(env: NodeJS.ProcessEnv, extra: readonly string[] = []): string[] {
  const own = SECRET_NAMES.map((name) => env[name] ?? "");
  return [...new Set([...hostSecrets(env), ...own, ...extra])].filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET);
}

/** The redactor over `values`: each one, in every form, replaced with "[redacted]". With none, text is left as it is. */
export function secretRedactor(values: readonly string[]): Redact {
  const kept = [...new Set(values.filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET))];
  if (kept.length === 0) return keepText;
  return (text) => (text ? redactedAnswer(text, kept) : text);
}
