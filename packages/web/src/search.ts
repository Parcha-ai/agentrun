// web_search's one answer shape (Search), its bounds, and searchInTurn: a call asks its backends in order, each behind
// a breaker of its own. A quota answer turns a backend off until the reset it names, else for the breaker's life; a rate
// limit holds it for the wait it named (60 s when none), and one naming a wait past 15 minutes turns it off for that
// wait. A backend that fails, answers no results, is held or is off passes the call to the next.
import { cutAt } from "./page.js";
import type { SearchProvider } from "./providers/registry.js";

/** The most of one keyword query a search sends (Parallel's own bound on a query). */
export const QUERY_MAX = 200;
/** The most of a search's objective, its goal in plain words, a search sends. */
export const OBJECTIVE_MAX = 1_000;
/** The most keyword queries a search keeps (Parallel's own bound). */
export const QUERIES_MAX = 5;
export const RESULTS_MAX = 25;
export const RESULTS_DEFAULT = 10;
/** The most of a result's text its snippet keeps. */
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

/** `relevance`, under the classifier's rerank+label policy only: how likely the result holds what the search asks
 *  for, 0 to 1. */
export type Hit = { url: string; title: string; snippet: string; published?: string; relevance?: number };
/** A search's answer: the provider that served it, the objective and the queries it was asked (searchArgs), and its
 *  results; or why there are none. */
export type Search = { provider: SearchProvider; objective: string; queries: string[]; results: Hit[]; text?: string; omitted?: number } | { error: string };
/** What a provider's failure said of the run's search: out of quota (until the reset `retryAfter` names, if it names
 *  one), or rate-limited, with the wait it named as it handed it back (a Retry-After header's value, delta-seconds or an
 *  HTTP date, or Exa's seconds). `repeatIsQuota`, the
 *  server's mark on keyless Exa's limit naming no wait alone (exaLimitOf): Exa answers its daily count running out as
 *  that limit, so the same answer again once a wait has passed is that count (searchBreaker). */
export type Limit = { kind: "quota"; retryAfter?: string | number } | { kind: "rate"; retryAfter?: string | number; repeatIsQuota?: true };
/** Why a provider gave no answer, by class: `infra` (no answer: a timeout, a connection or the endpoint failing, a 5xx),
 *  `quota` (a quota spent: credit, a daily limit), `rate` (a rate limit), `refused` (not sent or not served: no key, the
 *  key refused, the cap's refusal, the public-host guard), `not_text` (the provider read the page and gave no text),
 *  `error` (any other answer it gave that is no result). */
export type FailureClass = "infra" | "quota" | "rate" | "error" | "refused" | "not_text";
/** A failure typed: its class, a machine code (the provider's own where it names one, else ours: upper-case words joined
 *  by underscores) and the message in our words. `covers: "key"` marks a quota spent for the whole key (keyless: the
 *  host's allowance), which holds both of the provider's tools; with none, a limit holds the tool that met it alone. */
export type Failure = { class: FailureClass; code: string; message: string; covers?: "key" };
/** A failure as a provider answers one: the message as `error`, the failure typed, and the limit it met, if any. */
export type Failed = { error: string; failure: Failure; limit?: Limit };
/** `message` typed as `kind` with `code`. */
export const failure = (kind: FailureClass, code: string, message: string): Failure => ({ class: kind, code, message });
/** `message` failed as `kind` with `code`, and `limit` where one was met. */
export const failed = (kind: FailureClass, code: string, message: string, limit?: Limit): Failed => ({ error: message, failure: failure(kind, code, message), ...(limit ? { limit } : {}) });
/** `failed` marked as a quota of the whole key (Failure.covers). */
export const keyWide = (one: Failed): Failed => ({ ...one, failure: { ...one.failure, covers: "key" } });
/** `value` without its typed failure: what an exported call answers, as it did before failures were typed. */
export function bare<T>(value: T): T {
  if (typeof value !== "object" || value === null || !("failure" in value)) return value;
  const { failure: _typed, ...rest } = value as T & { failure: unknown };
  return rest as T;
}
/** A Search, and the failure and limit its provider answered, if any: the run's breaker reads `limit` (searchBreaker),
 *  the receipt `failure`, the model the Search alone. `worded`: the error is the provider's words for the model about the
 *  limit it met (a keyless search's, a caller's Words among them), which the breaker passes on where its own would say
 *  no more; else a limit's error is said in the breaker's words. */
export type Searched = { answer: Search; failure?: Failure; limit?: Limit; worded?: true };
/** A failed search as searchInTurn reads it. */
export const searchFailed = ({ error, failure, limit }: Failed): Searched => ({ answer: { error }, failure, ...(limit ? { limit } : {}) });

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
 *  already open; a repeatIsQuota limit after an earlier one whose wait has passed, with no success between, is a quota
 *  answer. The call that met a limit keeps any results it has; with none it answers `held`'s words, as the next call
 *  would, never the provider's for the limit. */
export type Breaker = { held(): Search | undefined; read(searched: Searched): Search; off(): boolean; left(): number; holding(): Holding | undefined };
/** What holds a breaker now: the kind of the limit that last held it, and when it may be asked again (Infinity: not in
 *  the breaker's life). */
export type Holding = { kind: Limit["kind"]; until: number };
/** `ms` of a wait as searchBusy's seconds: rounded up, at least 1. */
const busyFor = (ms: number): Search => ({ error: searchBusy(Math.max(1, Math.ceil(ms / 1_000))) });
export function searchBreaker(now: () => number = Date.now): Breaker {
  // Off while the clock is before it.
  let offTill = 0;
  let until = 0;
  // A marked rate limit (keyless Exa's) has opened a wait in this run, with no search succeeding since.
  let marked = false;
  // The kind of the limit that turned it off, and of the one that opened its wait.
  let offKind: Limit["kind"] = "quota";
  let waitKind: Limit["kind"] = "rate";
  const off = () => now() < offTill;
  const held = (): Search | undefined => {
    if (off()) return { error: SEARCH_UNAVAILABLE };
    const left = until - now();
    return left > 0 ? busyFor(left) : undefined;
  };
  return {
    holding() {
      if (off()) return { kind: offKind, until: offTill };
      return until > now() ? { kind: waitKind, until } : undefined;
    },
    held,
    off,
    left: () => Math.max(0, until - now()),
    read({ answer, limit, worded }) {
      if (!("error" in answer)) marked = false;
      if (!limit) return answer;
      const at = now();
      const till = offUntil(limit, at);
      // The call that met a limit answers its results if it has any (a merged search's other requests), else what a call
      // held by it answers (held: SEARCH_UNAVAILABLE, or searchBusy for its wait), never the provider's "answered 429";
      // a provider's own words for the model (worded) stand, but for a rate limit that turns it off ("try again" words).
      const heldOr = (words = !worded) => ("error" in answer && words ? (held() ?? answer) : answer);
      if (till !== undefined) {
        if (till >= offTill) offKind = limit.kind;
        offTill = Math.max(offTill, till);
        return heldOr(limit.kind === "rate" || !worded);
      }
      if (limit.kind === "rate" && limit.repeatIsQuota && marked && at >= until) {
        offTill = Number.POSITIVE_INFINITY;
        offKind = "quota";
        return { error: SEARCH_UNAVAILABLE };
      }
      if (limit.kind === "rate" && limit.repeatIsQuota) marked = true;
      until = Math.max(until, at + waitOf(limit.retryAfter, at));
      waitKind = limit.kind;
      return heldOr();
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
  const cut = cutAt(text, SNIPPET_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > SNIPPET_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What a search asks every provider: its objective, its keyword queries, and how many results. */
export type SearchAsk = { objective: string; queries: string[]; n: number };
/** `{objective, queries?, n?}` (or the deprecated `{query, n?}`) as every provider takes it: the objective trimmed and
 *  cut at OBJECTIVE_MAX; the queries a list of strings, each trimmed and cut at QUERY_MAX, blanks and repeats dropped,
 *  the first QUERIES_MAX kept; n 1 to RESULTS_MAX. A `query` stands for the objective where none is given, and for the
 *  one query where no queries are; with neither, the one query is the objective's first QUERY_MAX characters. An
 *  objective of "" asks nothing. */
export function searchArgs(args: Record<string, unknown>): SearchAsk {
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const query = text(args.query, OBJECTIVE_MAX);
  const objective = text(args.objective, OBJECTIVE_MAX) || query;
  const given = Array.isArray(args.queries) ? args.queries.map((one) => text(one, QUERY_MAX)).filter(Boolean) : [];
  const queries = [...new Set(given.length ? given : [query.slice(0, QUERY_MAX) || objective.slice(0, QUERY_MAX)])].filter(Boolean).slice(0, QUERIES_MAX);
  return { objective, queries, n: Math.max(1, Math.min(RESULTS_MAX, Math.floor(Number(args.n) || RESULTS_DEFAULT))) };
}

/** A backend a call of web_search asks: its name (its breaker's), and its one search. The keyless backends end at
 *  `deadline`, the call's one deadline for every backend it asks (searchInTurn); Parallel and a native search keep the
 *  caller's signal and their own bounds. */
export type Backend = { name: string; ask(deadline: AbortSignal): Promise<Searched> };
/** One backend's turn in a call: answered (`ok`), answered no results (`empty`: a search passed on to the next
 *  backend), failed (`error`: its message, the failure typed where the provider typed it, the limit it met), or held by
 *  its breaker. */
export type Try = { provider: string; outcome: "ok" | "empty" | "error" | "held"; error?: string; failure?: Failure; limit?: Limit; ms?: number };
/** The most one call of web_search spends across its keyless backends together: Firecrawl's failing or timing out
 *  leaves Exa what is left of it, never a fresh bound. Firecrawl's own bound inside it (FIRECRAWL_MS, 30 s) leaves Exa
 *  at least the rest. */
export const KEYLESS_SEARCH_MS = 60_000;
/** A call's bounds, a test's: `searchMs`, its one deadline (KEYLESS_SEARCH_MS); `firecrawlMs`, Firecrawl's own inside it
 *  (FIRECRAWL_MS). */
export type SearchBounds = { searchMs?: number; firecrawlMs?: number };

/** What a call stopped before any backend was asked answers (searchInTurn): the keyless backends' words for a stop. */
const SEARCH_STOPPED = "the search was stopped";

/** `name` held, in the model's words: out of quota or rate-limited, until its reset (UTC, to the second), or for the
 *  rest of the run where it named none. */
const heldWords = (name: string, holding: Holding): string =>
  `${name} is ${holding.kind === "quota" ? "out of quota" : "rate-limited"} ${Number.isFinite(holding.until) ? `until ${new Date(holding.until).toISOString().replace(/\.\d{3}Z$/, "Z")}` : "for the rest of this run"}`;

/** Whether a search's answer holds nothing for the model: no results and no short answer of its own (`text`). */
const emptyAnswer = (answer: Search): boolean => !("error" in answer) && !answer.results.length && !answer.text;

/** A call's search through `backends` in turn, each behind its breaker, all under one deadline (`boundMs` or `signal`):
 *  the first with results (or a short answer of its own) answers; one answering none passes the call on, and the first
 *  such answers only when no backend after it has results. None starts on a spent deadline: one spent before any was
 *  asked answers SEARCH_STOPPED, a stopped turn of the first not held. None left: SEARCH_UNAVAILABLE
 *  where every backend is off (a lone backend's own answer where it was asked), else the last failure (one that met a
 *  limit in its breaker's words), else searchBusy for the shortest wait. */
export async function searchInTurn(backends: readonly Backend[], breakerOf: (name: string) => Breaker, signal?: AbortSignal, boundMs: number = KEYLESS_SEARCH_MS, tries?: Try[]): Promise<Search> {
  const deadline = AbortSignal.any([AbortSignal.timeout(boundMs), ...(signal ? [signal] : [])]);
  let last: Search | undefined;
  // The first answer with no results: the call's, if no backend after it has any.
  let empty: Search | undefined;
  for (const backend of backends) {
    const breaker = breakerOf(backend.name);
    const held = breaker.held();
    if (held) {
      const holding = breaker.holding();
      tries?.push({ provider: backend.name, outcome: "held", ...(holding && "error" in held ? { failure: failure(holding.kind, "HELD", held.error) } : {}), ms: 0 });
      continue;
    }
    if (deadline.aborted) {
      if (last || empty) break;
      // A call stopped before any backend was asked starts none (a paid one would be held, or sent, for nothing): its
      // turn is the stopped one the backend would have answered, in the keyless backends' words.
      tries?.push({ provider: backend.name, outcome: "error", error: SEARCH_STOPPED, failure: failure("infra", "STOPPED", SEARCH_STOPPED), ms: 0 });
      return { error: SEARCH_STOPPED };
    }
    const started = tries ? performance.now() : 0;
    const searched = await backend.ask(deadline);
    const answer = breaker.read(searched);
    const outcome = "error" in answer ? "error" : emptyAnswer(answer) ? "empty" : "ok";
    // The receipt keeps what the provider said; the model reads the breaker's words for a limit.
    tries?.push({ provider: backend.name, outcome, ...("error" in answer ? { error: "error" in searched.answer ? searched.answer.error : answer.error, ...(searched.failure ? { failure: searched.failure } : {}) } : {}), ...(searched.limit ? { limit: searched.limit } : {}), ms: Math.round(performance.now() - started) });
    if (outcome === "ok") return answer;
    if (outcome === "empty") empty ??= answer;
    else last = answer;
  }
  const breakers = backends.map((backend) => breakerOf(backend.name));
  // Each backend off now, in the model's words: who, why, and when it may be asked again.
  const offs = backends.flatMap((backend, i) => {
    const holding = breakers[i]!.off() ? breakers[i]!.holding() : undefined;
    return holding ? [{ name: backend.name, holding }] : [];
  });
  // No results while a backend is held reads as "nothing exists": the answer says the search is short of it instead.
  if (empty) {
    const others = offs.filter(({ name }) => !("provider" in empty! && empty.provider === name));
    if (!others.length || "error" in empty) return empty;
    return { error: `${empty.provider} found no results, and ${others.map(({ name, holding }) => heldWords(name, holding)).join("; ")}; search again after that or answer from what you have` };
  }
  if (breakers.every((breaker) => breaker.off())) {
    // A hold with a named reset says so; one with none keeps SEARCH_UNAVAILABLE, as does a lone backend's own words.
    const named = offs.some(({ holding }) => Number.isFinite(holding.until));
    if (backends.length === 1 && last && !("error" in last && last.error === SEARCH_UNAVAILABLE)) return last;
    if (named) return { error: `search is unavailable: ${offs.map(({ name, holding }) => heldWords(name, holding)).join("; ")}; answer from what you have` };
    return backends.length === 1 && last ? last : { error: SEARCH_UNAVAILABLE };
  }
  // A backend that turned off in this call while another only waits: the run's search is not off, so it waits.
  if (last && !("error" in last && last.error === SEARCH_UNAVAILABLE)) return last;
  return busyFor(Math.min(...breakers.filter((breaker) => !breaker.off()).map((breaker) => breaker.left())));
}

/** `own`, one tool's breaker on a provider, joined with `key`, the provider's breaker across both tools: held while
 *  either holds; a limit whose failure covers the key (Failure.covers) trips both, any other `own` alone. */
export function withKeyBreaker(own: Breaker, key: Breaker): Breaker {
  return {
    held: () => own.held() ?? key.held(),
    read(searched) {
      if (searched.limit && searched.failure?.covers === "key") key.read(searched);
      return own.read(searched);
    },
    off: () => own.off() || key.off(),
    left: () => Math.max(own.left(), key.left()),
    holding: () => own.holding() ?? key.holding(),
  };
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
