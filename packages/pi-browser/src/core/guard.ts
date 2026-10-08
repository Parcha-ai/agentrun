// The never-retry-unchanged rule: a tool called with the same arguments that failed twice with the same failure is
// refused the third time with the way out; a success with those arguments clears the strikes.
import type { BrowserFailure } from "./failures.js";

export type RepeatGuard = {
  /** The refusal for this call, or null when it may run. */
  check(tool: string, args: unknown): BrowserFailure | null;
  /** Record a call's outcome: its failure, or null for a success. */
  note(tool: string, args: unknown, failure: BrowserFailure | null): void;
};

export function createRepeatGuard(): RepeatGuard {
  const strikes = new Map<string, { error: string; count: number }>();
  const keyOf = (tool: string, args: unknown) => `${tool}:${JSON.stringify(args ?? {})}`;
  return {
    check(tool, args) {
      const prior = strikes.get(keyOf(tool, args));
      if (!prior || prior.count < 2) return null;
      return { ok: false, code: "refused", retryable: false, effect: "none", message: `Refused: ${tool} with these exact arguments already failed ${prior.count} times with the same error ("${prior.error.slice(0, 200)}"). Change approach: snapshot again and use current IDs, change the code or the URL, browser_relaunch({verified:true}) if the site blocks you, or fall back to web_fetch.` };
    },
    note(tool, args, failure) {
      const key = keyOf(tool, args);
      if (!failure) { strikes.delete(key); return; }
      const error = `${failure.code}:${(failure.detail || failure.message).slice(0, 300)}`;
      const prior = strikes.get(key);
      strikes.set(key, prior && prior.error === error ? { error, count: prior.count + 1 } : { error, count: 1 });
    },
  };
}
