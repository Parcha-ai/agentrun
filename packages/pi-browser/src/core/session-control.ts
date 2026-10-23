import type { BrowserPolicy } from "./host.js";

export const DEFAULT_BROWSER_POLICY: Readonly<BrowserPolicy> = Object.freeze({
  proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000,
});

export const CREATE_DEADLINE_MS = 60_000;

export type KeyedSerializer = {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  keys(): string[];
};

export function keyedSerializer(): KeyedSerializer {
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const turn = (tails.get(key) ?? Promise.resolve()).then(work, work);
      const tail = turn.then(() => undefined, () => undefined);
      tails.set(key, tail);
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return turn;
    },
    keys: () => [...tails.keys()],
  };
}

export type IdleTracker<K = string> = {
  activity(key: K, delta: number, idleMs?: number): void;
  /** True while `fired` is the key's current timer and nothing is in flight: only then may an idle release go ahead. */
  isCurrent(key: K, fired: NodeJS.Timeout): boolean;
  cancel(key: K): void;
  /** Safe mid-call: a key with calls in flight goes when the last one ends, and no timer is armed after it. */
  forget(key: K): void;
  clear(): void;
  keys(): K[];
};

export function idleTracker<K = string>(options: { idleMs: number; onIdle(key: K, fired: NodeJS.Timeout, idleMs: number): void }): IdleTracker<K> {
  const entries = new Map<K, { inFlight: number; idleMs: number; timer?: NodeJS.Timeout; forgotten?: true }>();
  return {
    activity(key, delta, idleMs) {
      const entry = entries.get(key) ?? { inFlight: 0, idleMs: idleMs ?? options.idleMs };
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.inFlight = Math.max(0, entry.inFlight + delta);
      if (idleMs !== undefined) entry.idleMs = idleMs;
      if (entry.forgotten && entry.inFlight === 0) {
        entries.delete(key);
        return;
      }
      entries.set(key, entry);
      if (entry.inFlight > 0 || !(entry.idleMs > 0)) return;
      const timer: NodeJS.Timeout = setTimeout(() => options.onIdle(key, timer, entry.idleMs), entry.idleMs);
      entry.timer = timer;
      timer.unref?.();
    },
    isCurrent(key, fired) {
      const entry = entries.get(key);
      return entry?.timer === fired && entry.inFlight === 0;
    },
    cancel(key) {
      const entry = entries.get(key);
      if (entry?.timer) clearTimeout(entry.timer);
      if (entry) entry.timer = undefined;
    },
    forget(key) {
      const entry = entries.get(key);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      if (entry.inFlight === 0) entries.delete(key);
      else entry.forgotten = true;
    },
    clear() {
      for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
      entries.clear();
    },
    keys: () => [...entries.keys()],
  };
}

/** Every environment variable that holds a provider key: each redactor in either adapter scrubs their values. */
export const PROVIDER_KEY_ENV: readonly string[] = Object.freeze(["BROWSERBASE_API_KEY", "BB_API_KEY", "KERNEL_API_KEY"]);

export const providerKeyValues = (env: NodeJS.ProcessEnv, host?: () => readonly string[]): string[] =>
  [...PROVIDER_KEY_ENV.map((name) => env[name] ?? "").filter(Boolean), ...(host?.() ?? [])];

/** Runs one at a time, in arrival order: each starts once the one before it has settled, however that one ended. */
export function oneAtATime(): <T>(run: () => Promise<T>) => Promise<T> {
  let turn: Promise<unknown> = Promise.resolve();
  return (run) => { const mine = turn.then(run, run); turn = mine.catch(() => undefined); return mine; };
}
