// web_search's one answer shape (Search), its bounds, and searchInTurn: a call asks its backends in order, each behind
// a breaker of its own. A quota answer turns a backend off until the reset it names, else for the breaker's life; a rate
// limit holds it for the wait it named (60 s when none), and one naming a wait past 15 minutes turns it off for that
// wait. A backend that fails, is held or is off passes the call to the next.

export const QUERY_MAX = 200;
export const RESULTS_MAX = 25;
export const RESULTS_DEFAULT = 10;
/** The most of a result's text its snippet keeps; Parallel is asked for as much of each result's excerpts. */
export const SNIPPET_MAX = 3_000;
/** The most of the provider's own short answer (`text`) a search keeps (serve's hosted-search.ts). */
export const ANSWER_MAX = 4_000;
/** The most characters a search's answer takes, its citing line included: about RESULTS_MAX results with whole snippets,
 *  under the host's result bound (HOST_RESULT_MAX_CHARS), which the host-bounds test holds it to. */
export const SEARCH_MAX_CHARS = 100_000;
/** What a web_search call answers while its provider is off (offUntil): it is not asked until its limit resets, if in
 *  this run at all. */
export const SEARCH_UNAVAILABLE = "search is unavailable for the rest of this run; answer from what you have";
/** What a call answers while a rate limit's wait holds, `seconds` of it left. */
export const searchBusy = (seconds: number): string => `search is busy; try again in ${seconds} s, or answer from what you have`;
/** The wait a rate limit holds a run's search for when no Retry-After reaches here. */
const DEFAULT_WAIT_MS = 60_000;
/** The longest wait a rate limit holds a run's search for: 15 minutes. A wait named past it is a spent count with its
 *  reset (keyless Exa's daily count answers a 429 naming the hours to midnight): the provider is off until then. */
const MAX_WAIT_MS = 15 * 60_000;

export type Hit = { url: string; title: string; snippet: string; published?: string };
export type Search = { provider: "native" | "firecrawl-keyless" | "exa-keyless" | "parallel" | "exa" | "firecrawl"; query: string; results: Hit[]; text?: string; omitted?: number } | { error: string };
/** What a provider's failure said of the run's search: out of quota (until the reset `retryAfter` names, if it names
 *  one), or rate-limited, with the wait it named as it handed it back (a Retry-After header's value, delta-seconds or an
 *  HTTP date, or Exa's seconds). `repeatIsQuota`, the
 *  server's mark on keyless Exa's limit naming no wait alone (exaLimitOf): Exa answers its daily count running out as
 *  that limit, so the same answer again once a wait has passed is that count (searchBreaker). */
export type Limit = { kind: "quota"; retryAfter?: string | number } | { kind: "rate"; retryAfter?: string | number; repeatIsQuota?: true };
/** A Search, and the limit its provider answered, if any: the run's breaker reads `limit` (searchBreaker), the model the
 *  Search alone. */
export type Searched = { answer: Search; limit?: Limit };

/** The wait a Retry-After names, in ms from `nowMs` (negative for a date already passed): delta-seconds or an HTTP date,
 *  or a number of seconds; undefined when it names neither. The one reading of a Retry-After here. */
export function retryAfterMs(retryAfter: string | number | undefined, nowMs: number): number | undefined {
  const said = typeof retryAfter === "string" ? retryAfter.trim() : retryAfter;
  const ms = typeof said === "number" ? said * 1_000 : said && /^\d+$/.test(said) ? Number(said) * 1_000 : said ? Date.parse(said) - nowMs : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** The wait a breaker holds for `retryAfter` (retryAfterMs): none named, 60 s; a date already passed, none; never more
 *  than 15 minutes (MAX_WAIT_MS: a longer one turns its provider off, offUntil). */
export function waitOf(retryAfter: string | number | undefined, nowMs: number): number {
  const ms = retryAfterMs(retryAfter, nowMs);
  return ms === undefined ? DEFAULT_WAIT_MS : Math.min(Math.max(ms, 0), MAX_WAIT_MS);
}

/** When `limit`, met at `nowMs`, turns its provider off: the time it may be asked again (Infinity: not in the breaker's
 *  life), or undefined when the limit only holds it for a wait (waitOf). A quota is off until the reset it names, else
 *  for good; a rate limit naming a wait past MAX_WAIT_MS is off until that wait ends. */
export function offUntil(limit: Limit, nowMs: number): number | undefined {
  const ms = retryAfterMs(limit.retryAfter, nowMs);
  if (limit.kind === "quota") return ms === undefined ? Number.POSITIVE_INFINITY : nowMs + Math.max(ms, 0);
  return ms !== undefined && ms > MAX_WAIT_MS ? nowMs + ms : undefined;
}

/** A breaker on one backend, read at `now`. `held`: what a call answers unsent while it holds (SEARCH_UNAVAILABLE once
 *  off, searchBusy for the seconds left of a wait). `read` takes a search and its limit: a quota answer, or a rate limit
 *  naming a wait past 15 minutes, turns it off (offUntil); a shorter rate limit opens a wait, never shrinking one
 *  already open; a repeatIsQuota limit after an earlier one whose wait has
 *  passed, with no success between, is a quota answer and the call answers SEARCH_UNAVAILABLE. */
export type Breaker = { held(): Search | undefined; read(searched: Searched): Search; off(): boolean; left(): number };
/** `ms` of a wait as searchBusy's seconds: rounded up, at least 1. */
const busyFor = (ms: number): Search => ({ error: searchBusy(Math.max(1, Math.ceil(ms / 1_000))) });
export function searchBreaker(now: () => number = Date.now): Breaker {
  // Off while the clock is before it.
  let offTill = 0;
  let until = 0;
  // A marked rate limit (keyless Exa's) has opened a wait in this run, with no search succeeding since.
  let marked = false;
  const off = () => now() < offTill;
  return {
    held() {
      if (off()) return { error: SEARCH_UNAVAILABLE };
      const left = until - now();
      return left > 0 ? busyFor(left) : undefined;
    },
    off,
    left: () => Math.max(0, until - now()),
    read({ answer, limit }) {
      if (!("error" in answer)) marked = false;
      if (!limit) return answer;
      const at = now();
      const till = offUntil(limit, at);
      // The call that turns search off for a rate limit answers so itself, never its limit's "try again" words.
      if (till !== undefined) {
        offTill = Math.max(offTill, till);
        return limit.kind === "quota" ? answer : { error: SEARCH_UNAVAILABLE };
      }
      if (limit.kind === "rate" && limit.repeatIsQuota && marked && at >= until) {
        offTill = Number.POSITIVE_INFINITY;
        return { error: SEARCH_UNAVAILABLE };
      }
      if (limit.kind === "rate" && limit.repeatIsQuota) marked = true;
      until = Math.max(until, at + waitOf(limit.retryAfter, at));
      return answer;
    },
  };
}
/** The line that ends a search's answer to the model, as Claude Code's WebSearch ends its own. */
export const CITE = "Cite the URL of each result you rely on.";

/** `answer` within SEARCH_MAX_CHARS, as searchText writes it: whole when it fits, else without its least relevant results
 *  (the last), as many as it takes, `omitted` counting them. */
export function fitSearch(answer: Search): Search {
  if ("error" in answer) return answer;
  const room = SEARCH_MAX_CHARS - CITE.length - 1;
  let fitted: Search = answer;
  for (let kept = answer.results.length; JSON.stringify(fitted).length > room && kept > 0; ) {
    kept -= 1;
    fitted = { ...answer, results: answer.results.slice(0, kept), omitted: answer.results.length - kept };
  }
  return fitted;
}

/** A search as the model reads it: its JSON (fitSearch), then the line asking it to cite the URLs it relies on; an
 *  error's JSON alone. */
export function searchText(answer: Search): string {
  const fitted = fitSearch(answer);
  return "error" in fitted ? JSON.stringify(fitted) : `${JSON.stringify(fitted)}\n${CITE}`;
}

/** A result's text as its snippet: links reduced to their text, whitespace collapsed, cut at SNIPPET_MAX on a word. */
export function snippetOf(raw: string): string {
  const text = raw.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1").replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET_MAX) return text;
  const cut = text.slice(0, SNIPPET_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > SNIPPET_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `{query, n?}` as every provider takes it: the query trimmed and cut at QUERY_MAX, n 1 to RESULTS_MAX. */
export const searchArgs = (args: Record<string, unknown>) => ({
  query: typeof args.query === "string" ? args.query.trim().slice(0, QUERY_MAX) : "",
  n: Math.max(1, Math.min(RESULTS_MAX, Math.floor(Number(args.n) || RESULTS_DEFAULT))),
});

/** A backend a call of web_search asks: its name (its breaker's), and its one search. The keyless backends end at
 *  `deadline`, the call's one deadline for every backend it asks (searchInTurn); Parallel and a native search keep the
 *  caller's signal and their own bounds. */
export type Backend = { name: string; ask(deadline: AbortSignal): Promise<Searched> };
/** One backend's turn in a call: answered (`ok`), failed (`error`, with the limit it met), or held by its breaker. */
export type Try = { provider: string; outcome: "ok" | "error" | "held"; error?: string; limit?: Limit; ms?: number };
/** The most one call of web_search spends across its keyless backends together: Firecrawl's failing or timing out
 *  leaves Exa what is left of it, never a fresh bound. Firecrawl's own bound inside it (FIRECRAWL_MS, 30 s) leaves Exa
 *  at least the rest. */
export const KEYLESS_SEARCH_MS = 60_000;
/** A call's bounds, a test's: `searchMs`, its one deadline (KEYLESS_SEARCH_MS); `firecrawlMs`, Firecrawl's own inside it
 *  (FIRECRAWL_MS). */
export type SearchBounds = { searchMs?: number; firecrawlMs?: number };

/** A call's search through `backends` in turn, each behind its breaker, all under one deadline (`boundMs` or `signal`):
 *  the first with results answers; none starts on a spent deadline. None left: SEARCH_UNAVAILABLE where every backend is
 *  off (a lone backend's own answer where it was asked), else the last failure, else searchBusy for the shortest wait. */
export async function searchInTurn(backends: readonly Backend[], breakerOf: (name: string) => Breaker, signal?: AbortSignal, boundMs: number = KEYLESS_SEARCH_MS, tries?: Try[]): Promise<Search> {
  const deadline = AbortSignal.any([AbortSignal.timeout(boundMs), ...(signal ? [signal] : [])]);
  let last: Search | undefined;
  for (const backend of backends) {
    const breaker = breakerOf(backend.name);
    if (breaker.held()) {
      tries?.push({ provider: backend.name, outcome: "held", ms: 0 });
      continue;
    }
    if (last && deadline.aborted) break;
    const started = tries ? performance.now() : 0;
    const searched = await backend.ask(deadline);
    const answer = breaker.read(searched);
    tries?.push({ provider: backend.name, outcome: "error" in answer ? "error" : "ok", ...("error" in answer ? { error: answer.error } : {}), ...(searched.limit ? { limit: searched.limit } : {}), ms: Math.round(performance.now() - started) });
    if (!("error" in answer)) return answer;
    last = answer;
  }
  const breakers = backends.map((backend) => breakerOf(backend.name));
  if (breakers.every((breaker) => breaker.off())) return backends.length === 1 && last ? last : { error: SEARCH_UNAVAILABLE };
  // A backend that turned off in this call while another only waits: the run's search is not off, so it waits.
  if (last && !("error" in last && last.error === SEARCH_UNAVAILABLE)) return last;
  return busyFor(Math.min(...breakers.filter((breaker) => !breaker.off()).map((breaker) => breaker.left())));
}

/** Breakers by backend name, made at first use: one run's (serve's webSearchTool), or one call's (its searchFor). */
export const breakers = (now: () => number = Date.now) => {
  const made = new Map<string, Breaker>();
  return (name: string): Breaker => {
    let breaker = made.get(name);
    if (!breaker) made.set(name, (breaker = searchBreaker(now)));
    return breaker;
  };
};
