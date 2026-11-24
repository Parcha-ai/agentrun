// GET /v2/wrapped: a year of the work under this machine's home (Claude Code, Codex, pi and every other source the import
// package reads), as numbers. The import package's wrappedHome does the reading; this is its answer in the API's words,
// with the runs imported here beside it. Numbers and names only: no prompt, title, path or project is in it.
import { homedir } from "node:os";
import type { ReadFailure, Wrapped } from "@parcha/agentrun-import";

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

/** A year read lately is not read again for a minute: a whole home is a long read, and the page asks for it on every open.
 *  A read still going is shared however long it takes; its minute starts when it ends. */
const KEEP_MS = 60_000;
type Read = { wrapped: Wrapped; unread: number };
type Kept = { read: Promise<Read>; at?: number };
const kept = new Map<string, Kept>();

/** The year's wrappedHome over this machine's home, shared by the reads of the minute, and how many session files it could
 *  not read (one gone since it was listed, or one this user cannot open): the numbers are short by those, and say so. */
export function readWrapped(year: number, now = Date.now()): Promise<Read> {
  const home = homedir();
  const key = `${home}:${year}`;
  const held = kept.get(key);
  if (held && (held.at === undefined || now - held.at < KEEP_MS)) return held.read;
  const failures: ReadFailure[] = [];
  const read = import("@parcha/agentrun-import").then(async ({ wrappedHome }) => ({ wrapped: await wrappedHome(home, year, { failures }), unread: failures.length }));
  const entry: Kept = { read };
  kept.set(key, entry);
  read.then(
    () => {
      entry.at = Date.now();
    },
    () => {
      if (kept.get(key) === entry) kept.delete(key);
    },
  );
  return read;
}
