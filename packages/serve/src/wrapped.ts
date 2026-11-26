// GET /v2/wrapped: a year of the work under this machine's home (Claude Code, Codex, pi and every other source the import
// package reads), as numbers. The import package's wrappedHome does the reading; this is its answer in the API's words,
// with the runs imported here beside it. Numbers and names only: no prompt, title, path or project is in it.
import { CACHE_CAUSES, HARNESS_OF, type Wrapped } from "@parcha/agentrun-import";
import type { StoreAnalytics } from "./store-reads/analytics.js";

const total = ({ input, output, cacheRead, cacheWrite }: Wrapped["tokens"]) => input + output + cacheRead + cacheWrite;

/** The year's imported runs' cache (the store's sums, StoreAnalytics.cache) as GET /v2/wrapped serves it: null when no
 *  run of the year was analyzed. Each cause there, 0 where none. Only runs imported here are in it: a session the owner
 *  left out of the import, or imported before the import analyzed caches, is not. */
export function cacheView(cache: StoreAnalytics["cache"] | undefined) {
  if (!cache?.runs) return null;
  const byCause = (counts: Record<string, number>) => Object.fromEntries(CACHE_CAUSES.map((cause) => [cause, counts[cause] ?? 0]));
  return {
    runs: cache.runs,
    hit_rate: cache.prompt > 0 ? Math.round((cache.read / cache.prompt) * 1e4) / 1e4 : null,
    breaks: byCause(cache.breaks),
    extra_cost_usd: byCause(cache.extraCost),
    unpriced_breaks: cache.unpriced,
  };
}

/** `wrapped` (the import package's) as GET /v2/wrapped serves it, the runs imported from each source (`imported`), and
 *  their cache (`cache`, cacheView). */
export function wrappedView(wrapped: Wrapped, imported: readonly { source: string; runs: number }[], unreadFiles = 0, cache?: StoreAnalytics["cache"]) {
  const { input, output, cacheRead, cacheWrite } = wrapped.tokens;
  return {
    year: wrapped.year,
    sessions: wrapped.sessions,
    turns: wrapped.turns,
    requests: wrapped.requests,
    tokens: { input, output, cache_read: cacheRead, cache_write: cacheWrite },
    cost_usd: wrapped.cost,
    unpriced_requests: wrapped.unpricedRequests,
    days: wrapped.days,
    hours: wrapped.hours,
    weekdays: wrapped.weekdays,
    active_ms: wrapped.activeMs,
    // The sources behind each harness (several can share one), so the console links a harness's numbers to their runs
    // without a copy of the table, in the order of `sources`: a source of a reader outside it is its own harness, as wrappedHome counts it.
    harnesses: wrapped.harnesses.map((h) => ({ ...h, sources: wrapped.sources.map((s) => s.source).filter((source) => ((HARNESS_OF as Record<string, string | undefined>)[source] ?? source) === h.harness) })),
    models: wrapped.models.map(({ model, requests, tokens, cost, unpricedRequests }) => ({ model, requests, tokens: total(tokens), cost_usd: cost, unpriced_requests: unpricedRequests })),
    sources: wrapped.sources,
    imported: imported.map(({ source, runs }) => ({ source, runs })),
    unread_files: unreadFiles,
    cache: cacheView(cache),
  };
}

/** A read of the current year is kept for a minute after it ends: a whole home is a long read. */
const KEEP_MS = 60_000;
/** How long GET /v2/wrapped waits for a read before it answers 503 with a retry (the read goes on). */
export const WRAPPED_WAIT_MS = 15_000;
/** A year's wrappedHome over this machine's home, and how many session files it could not read (one gone since it was
 *  listed, or one this user cannot open): the numbers are short by those, and say so. */
export type WrappedRead = { wrapped: Wrapped; unread: number };

/** `read` (one year's read, on the server's import worker), each year's shared: a read still going, or waiting its turn,
 *  is shared however long it takes; once it ends, a year already over when its read began is kept until the server stops
 *  (its requests were all in), and any other (this year's, or one that ended while it was read) for a minute. One read at
 *  a time: each is a worker holding a year's sessions, so a year asked while another is read waits for it to end. A read
 *  that fails frees the turn and is kept for a minute too, whatever its year: an ask within it gets the same failure, not
 *  another read of a home that fails it (one past the worker's heap would fail each one). One per server. */
export function keptReads(read: (year: number) => Promise<WrappedRead>): (year: number) => Promise<WrappedRead> {
  type Entry = { read: Promise<WrappedRead>; began?: number; at?: number; failed?: boolean };
  const kept = new Map<number, Entry>();
  // The read whose turn it is or the last one given a turn, until it ends: the next starts after it.
  let turn: Promise<void> | undefined;
  const inTurn = (start: () => Promise<WrappedRead>): Promise<WrappedRead> => {
    const started = turn ? turn.then(start) : start();
    const mine = started.then(
      () => undefined,
      () => undefined,
    );
    turn = mine;
    void mine.then(() => {
      if (turn === mine) turn = undefined;
    });
    return started;
  };
  return (year) => {
    const held = kept.get(year);
    const now = Date.now();
    if (held && (held.at === undefined || (!held.failed && year < held.began!) || now - held.at < KEEP_MS)) return held.read;
    const entry: Entry = {} as Entry;
    entry.read = inTurn(() => {
      entry.began = new Date(Date.now()).getFullYear();
      return read(year);
    });
    kept.set(year, entry);
    entry.read.then(
      () => {
        entry.at = Date.now();
      },
      () => {
        entry.at = Date.now();
        entry.failed = true;
      },
    );
    return entry.read;
  };
}

/** keptReads over `read`, with each failed read given to `log` once, as it fails: the ask that started it may have had its
 *  answer (a 503) long before, and the asks in the minute it is kept get the same failure, not another read or log. */
export function loggedReads(read: (year: number) => Promise<WrappedRead>, log: (year: number, error: Error) => void): (year: number) => Promise<WrappedRead> {
  return keptReads((year) =>
    read(year).catch((error: Error) => {
      log(year, error);
      throw error;
    }),
  );
}

/** `read`'s answer if it comes within `ms`, else undefined (the read goes on). */
export async function within<T>(read: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => void (timer = setTimeout(resolve, ms, undefined)));
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}
