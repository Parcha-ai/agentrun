// GET /v2/wrapped: a year of the work under this machine's home (Claude Code, Codex, pi and every other source the import
// package reads), as numbers. The import package's wrappedHome does the reading; this is its answer in the API's words,
// with the runs imported here beside it. Numbers and names only: no prompt, title, path or project is in it.
import { homedir } from "node:os";
import type { Wrapped } from "@parcha/agentrun-import";

const total = ({ input, output, cacheRead, cacheWrite }: Wrapped["tokens"]) => input + output + cacheRead + cacheWrite;

/** `wrapped` (the import package's) as GET /v2/wrapped serves it, and the runs imported from each source (`imported`). */
export function wrappedView(wrapped: Wrapped, imported: readonly { source: string; runs: number }[]) {
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
  };
}

/** A year read lately is not read again for a minute: a whole home is a long read, and the page asks for it on every open. */
const KEEP_MS = 60_000;
const kept = new Map<string, { at: number; read: Promise<Wrapped> }>();

/** The year's wrappedHome over this machine's home, shared by the reads of the minute. */
export function readWrapped(year: number, now = Date.now()): Promise<Wrapped> {
  const home = homedir();
  const key = `${home}:${year}`;
  const held = kept.get(key);
  if (held && now - held.at < KEEP_MS) return held.read;
  const read = import("@parcha/agentrun-import").then(({ wrappedHome }) => wrappedHome(home, year, { failures: [] }));
  kept.set(key, { at: now, read });
  read.catch(() => kept.delete(key));
  return read;
}
