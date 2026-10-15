// The environment one start adds to its instance (`StartAttempt.env`): a place's per-attempt order. Each driver merges it
// over its own `env`, where `env` already goes. PATH and PDA_HOLDER are the driver's on every driver, so an order that
// sets either is refused rather than left to each driver's merge order.
import type { StartAttempt } from "../supervise.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DRIVER_KEYS = new Set(["PATH", "PDA_HOLDER"]);

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
