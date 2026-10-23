// The environment one start adds to its instance (`StartAttempt.env`): a place's per-attempt order. Each driver merges it
// over its own `env`, where `env` already goes. PATH and PDA_HOLDER are the driver's on every driver, so an order that
// sets either is refused rather than left to each driver's merge order.
import type { StartAttempt } from "../supervise.ts";

/** A name an environment variable can have. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DRIVER_KEYS = new Set(["PATH", "PDA_HOLDER"]);
const KEY_SEGMENTS = new Set(["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "CREDENTIALS"]);

/**
 * Whether `name` is a secret's name: one of its `_`-separated segments, in any case, is KEY, TOKEN, SECRET, PASSWORD,
 * PASSWD, CREDENTIAL or CREDENTIALS. Segments, not suffixes, so MODAL_TOKEN_ID is one too; CACHE_KEY_PREFIX is refused
 * as well, and renamed, which is the cheaper error. A start's environment is readable in the instance, so a secret never
 * goes there.
 */
export function keyShaped(name: string): boolean {
  return name.split("_").some((segment) => KEY_SEGMENTS.has(segment.toUpperCase()));
}

/** The start's extra environment, checked: PATH, PDA_HOLDER, a name that is not a variable name, or a value with a NUL, is `refuse`'s error. */
export function attemptEnv(attempt: StartAttempt | undefined, refuse: (message: string) => Error): Record<string, string> {
  const env = attempt?.env ?? {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) throw refuse(`${JSON.stringify(name)} is not an environment variable name`);
    if (DRIVER_KEYS.has(name)) throw refuse(`${name} is the driver's: a start cannot set it`);
    if (typeof value !== "string" || value.includes("\0")) throw refuse(`the value of ${name} is not a string without NUL`);
  }
  return env;
}
