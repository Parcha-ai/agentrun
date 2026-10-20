import { browserFailure, type BrowserFailure } from "./failures.js";

export type RepeatGuard = {
  check(tool: string, args: unknown): BrowserFailure | null;
  note(tool: string, args: unknown, failure: BrowserFailure | null): void;
  /** An effectful call the page never answered may have acted: the identical call (the same tool and effect key) is
   *  refused, as after an interruption, until the next look. In memory only, like the strikes: the failure that held
   *  it tells the model to look first, so a restart that forgets the hold loses nothing it was not told. */
  hold(tool: string, effect: string): void;
  held(tool: string, effect: string): boolean;
  /** A snapshot or browser_read: every held call may run again. */
  looked(): void;
};

/** `redact` runs over the whole error before the cuts below, so no fragment of a registered value reaches the refusal. */
export function createRepeatGuard(redact: (text: string) => string = (text) => text): RepeatGuard {
  const strikes = new Map<string, { error: string; count: number }>();
  const holds = new Set<string>();
  const keyOf = (tool: string, args: unknown) => `${tool}:${JSON.stringify(args ?? {})}`;
  return {
    check(tool, args) {
      const prior = strikes.get(keyOf(tool, args));
      if (!prior || prior.count < 2) return null;
      return browserFailure("refused", `Refused: ${tool} with these exact arguments already failed ${prior.count} times with the same error ("${prior.error.slice(0, 200)}"). Change approach: snapshot again and use current IDs, change the code or the URL, browser_relaunch({verified:true}) if the site blocks you, or fall back to web_fetch.`);
    },
    hold(tool, effect) { holds.add(`${tool}:${effect}`); },
    held(tool, effect) { return holds.has(`${tool}:${effect}`); },
    looked() { holds.clear(); },
    note(tool, args, failure) {
      if (failure?.code === "aborted") return;
      const key = keyOf(tool, args);
      if (!failure) { strikes.delete(key); return; }
      const error = `${failure.code}:${redact(failure.detail || failure.message).slice(0, 300)}`;
      const prior = strikes.get(key);
      strikes.set(key, prior && prior.error === error ? { error, count: prior.count + 1 } : { error, count: 1 });
    },
  };
}
