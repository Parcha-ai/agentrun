// The one intake rule for a secret a run's caller hands it (a tool key in `keys`, model_key): one every cut can hold. A
// cut (runner/redact.ts) leaves out a value under MIN_SECRET characters, which would match too much text by chance, so a
// shorter key would be laid for the run and never cut from what it writes. A key goes in a header, so it is visible
// ASCII alone: each character one UTF-16 unit, one code point and one byte, so every count of it agrees.
import type { InputIssue } from "./errors.js";
import { MIN_SECRET } from "./learn/secrets.js";

/** A handed key's characters: visible ASCII alone, no space. The API's schema states the same (openapi.ts). */
export const HANDED_SECRET = /^[\x21-\x7e]+$/;

/** Why `value` (text) is not a key a run can be handed at `field`, as a 422 issue that never shows it, or undefined for
 *  one it can: MIN_SECRET to `max` characters of visible ASCII. */
export function handedSecretOf(value: string, field: string, max: number): InputIssue | undefined {
  const wrong = value.length < MIN_SECRET ? `at least ${MIN_SECRET} characters: a shorter key can't be cut from what the run writes`
    : value.length > max ? `at most ${max} characters`
    : !HANDED_SECRET.test(value) ? "visible ASCII alone, with no space or control character: a key goes in a header"
    : undefined;
  return wrong === undefined ? undefined : { field, reason: "invalid", message: `${field} is ${wrong}.` };
}
