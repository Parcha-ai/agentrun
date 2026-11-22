// The one intake rule for a secret a run's caller hands it (a tool key in `keys`, model_key): one every cut can hold. A
// cut (runner/redact.ts) leaves out a value under MIN_SECRET, which would match too much text by chance, so a shorter key
// would be laid for the run and never cut from what it writes. A key goes in a header, so it holds no space or control
// character.
import type { InputIssue } from "./errors.js";
import { MIN_SECRET } from "./learn/secrets.js";

/** Why `value` (text) is not a key a run can be handed at `field`, as a 422 issue that never shows it, or undefined for
 *  one it can: MIN_SECRET to `max` characters with no space or control character. */
export function handedSecretOf(value: string, field: string, max: number): InputIssue | undefined {
  const wrong = value.length < MIN_SECRET ? `at least ${MIN_SECRET} characters: a shorter key can't be cut from what the run writes`
    : value.length > max ? `at most ${max} characters`
    : /[\s\x00-\x1f\x7f]/.test(value) ? "text with no space or control character"
    : undefined;
  return wrong === undefined ? undefined : { field, reason: "invalid", message: `${field} is ${wrong}.` };
}
