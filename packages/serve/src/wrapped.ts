// GET /v2/wrapped: a year of the work under this machine's home (Claude Code, Codex, pi and every other source the import
// package reads), as numbers. The import package's wrappedHome does the reading; this is its answer in the API's words,
// with the runs imported here beside it. Numbers and names only: no prompt, title, path or project is in it.
import type { Wrapped } from "@parcha/agentrun-import";

const total = ({ input, output, cacheRead, cacheWrite }: Wrapped["tokens"]) => input + output + cacheRead + cacheWrite;

/** `wrapped` (the import package's) as GET /v2/wrapped serves it, and the runs imported from each source (`imported`). */
export function wrappedView(wrapped: Wrapped, imported: readonly { source: string; runs: number }[], unreadFiles = 0) {
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
    harnesses: wrapped.harnesses,
    models: wrapped.models.map(({ model, requests, tokens, cost }) => ({ model, requests, tokens: total(tokens), cost_usd: cost })),
    sources: wrapped.sources,
    imported: imported.map(({ source, runs }) => ({ source, runs })),
    unread_files: unreadFiles,
  };
}

/** A read of the current year is kept for a minute after it ends: a whole home is a long read. */
const KEEP_MS = 60_000;
/** How long GET /v2/wrapped waits for a read before it answers 503 with a retry (the read goes on). */
export const WRAPPED_WAIT_MS = 15_000;
/** A year's wrappedHome over this machine's home, and how many session files it could not read (one gone since it was
 *  listed, or one this user cannot open): the numbers are short by those, and say so. */
export type WrappedRead = { wrapped: Wrapped; unread: number };

/** `read` (one year's read, on the server's import worker), each year's shared: a read still going is shared however long
 *  it takes; once it ends, the current year's is kept for a minute and a year already over is kept until the server
 *  stops (its requests are all in). A read that fails is dropped, so the next ask reads again. One per server. */
export function keptReads(read: (year: number) => Promise<WrappedRead>): (year: number) => Promise<WrappedRead> {
  const kept = new Map<number, { read: Promise<WrappedRead>; at?: number }>();
  return (year) => {
    const held = kept.get(year);
    const now = Date.now();
    if (held && (held.at === undefined || year < new Date(now).getFullYear() || now - held.at < KEEP_MS)) return held.read;
    const entry: { read: Promise<WrappedRead>; at?: number } = { read: read(year) };
    kept.set(year, entry);
    entry.read.then(
      () => {
        entry.at = Date.now();
      },
      () => {
        if (kept.get(year) === entry) kept.delete(year);
      },
    );
    return entry.read;
  };
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
