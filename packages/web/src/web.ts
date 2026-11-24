// Web search and web fetch as one object a run holds (createWeb), on the same functions serve composes itself: the
// providers asked are data (WebConfig.order), and everything from outside comes in through the config, as data or an
// injected function: the public-host guard and HTML reader (guard.ts), the run's cap (Pay, fees.ts), a native search
// on the run's own model credential, the words a product says. One Web holds one run's state: a breaker per search
// provider, its page cache, Parallel's refused-key state, keyless Firecrawl's breaker.
//
// Every answer comes with a Receipt: what was asked, which provider answered, each provider's turn, what the answer
// takes as the model reads it, and what it cost. Phase 1 judges nothing, so the classifier is "off" and the wall and
// injection verdicts "unjudged".
import { AsyncLocalStorage } from "node:async_hooks";
import { type WebLog, type FetchProvider, type Pages, type WebPage, webFetch, webFetchText } from "./fetch.js";
import { type Fee, type Pay, unmetered } from "./fees.js";
import type { Guard } from "./guard.js";
import { clip, type Page, type Part, partProblem, URL_MAX } from "./page.js";
import { type ExaLimited, exaLimitOf, exaSearch } from "./providers/exa-keyless.js";
import { type FirecrawlFailed, firecrawlFetch, firecrawlSearch, type KeylessFetch } from "./providers/firecrawl-keyless.js";
import type { Words } from "./providers/mcp.js";
import { type Extract, parallelExtract, parallelSearched } from "./providers/parallel.js";
import { type Backend, type Breaker, breakers, type Search, type SearchBounds, type Searched, searchArgs, searchInTurn, searchText, type Try } from "./search.js";

/** A provider, as an order or a receipt names it. */
export type ProviderId = "parallel" | "firecrawl-keyless" | "exa-keyless" | "native" | "direct";
/** A search provider, as an order names it. */
export type SearchProvider = Exclude<ProviderId, "direct">;
/** A native search: the run's own model provider's hosted search (serve's hosted-search.ts), injected. `signal` is the
 *  caller's: a native search keeps its own bounds. */
export type NativeSearch = (query: string, n: number, signal?: AbortSignal) => Promise<Searched>;

/** What one search is given: the providers of `order` in turn, each through its breaker (`breakerOf`, by its name),
 *  under the caller's `signal` and `bounds`; Parallel's client (made when Parallel's turn comes; null: no key), the
 *  native search, keyless Firecrawl's endpoint and fetch, keyless Exa's fetch, the caller's `words`, and `tries`, which
 *  collects each provider's turn. */
export type SearchWith = {
  order: readonly SearchProvider[];
  breakerOf: (name: string) => Breaker;
  signal?: AbortSignal;
  bounds?: SearchBounds;
  parallel?: () => Extract | null;
  native?: NativeSearch;
  firecrawl?: { endpoint?: string; send?: typeof fetch };
  exa?: { send?: typeof fetch };
  words?: Words;
  tries?: Try[];
};

/** A provider's own failure as a Searched: the error alone for the model, the limit it met for the breaker. */
const failedWith = (error: string, limit: Searched["limit"]): Searched => ({ answer: { error }, ...(limit ? { limit } : {}) });

/** `{query, n?}` searched by the providers of `with.order` in turn (searchInTurn). A query is needed before any is asked,
 *  but where Parallel is in the order: Parallel's search says so itself, as its own answer. */
export async function searchWith(args: Record<string, unknown>, w: SearchWith): Promise<Search> {
  const { query, n } = searchArgs(args);
  if (!w.order.includes("parallel") && !query) return { error: "web_search needs a query" };
  if (!w.order.length) return { error: "web_search has no provider to ask" };
  const backends = w.order.map((name): Backend => {
    if (name === "parallel") return { name, ask: () => parallelSearched(args, w.parallel?.() ?? null, w.signal) };
    if (name === "native") return { name, ask: async () => (w.native ? w.native(query, n, w.signal) : { answer: { error: "web_search: no native search was given" } }) };
    if (name === "firecrawl-keyless") {
      return { name, ask: async (deadline) => {
        const found: Search | FirecrawlFailed = await firecrawlSearch(query, n, { ...(w.firecrawl?.endpoint ? { endpoint: w.firecrawl.endpoint } : {}), ...(w.firecrawl?.send ? { send: w.firecrawl.send } : {}), signal: deadline, ...(w.bounds?.firecrawlMs === undefined ? {} : { timeoutMs: w.bounds.firecrawlMs }), ...(w.words ? { words: w.words } : {}) });
        // Which limit Firecrawl met is the breaker's to read, never the model's: it reads the error alone.
        if (!("error" in found)) return { answer: found };
        return failedWith(found.error, "limit" in found ? found.limit : undefined);
      } };
    }
    return { name, ask: async (deadline) => {
      const found: Search | ExaLimited = await exaSearch(query, n, { ...(w.exa?.send ? { send: w.exa.send } : {}), signal: deadline, ...(w.words ? { words: w.words } : {}) });
      if (!("limit" in found)) return { answer: found };
      return failedWith(found.error, exaLimitOf(found));
    } };
  });
  return searchInTurn(backends, w.breakerOf, w.signal, w.bounds?.searchMs, w.tries);
}

/** What an answer took and cost, beside it: never in front of the model. `out` is the answer as the model reads it
 *  (searchText, webFetchText); `cost` the fees of the requests sent for it; `cache` "hit" when a fetch came from the
 *  run's pages. */
export type Receipt = {
  op: "search" | "fetch";
  asked: string;
  provider: ProviderId | null;
  tries: Try[];
  classifier: "off";
  wall: { verdict: "unjudged" };
  injection: "unjudged";
  out: { bytes: number; chars: number };
  cost: { usd: number; lines: Fee[] };
  cache?: "hit";
};

/** One run's web: what it searches and fetches with. `order` is data: the search providers asked in turn, and the fetch
 *  providers ahead of the direct fetch ("direct" in it). `keys.parallel`: Parallel's key (none: Parallel answers that the
 *  run holds none). `guard`: the public-host guard and HTML reader (none: nothing is fetched directly, and no URL is
 *  sent to a provider). `pay`: the run's cap (none: unmetered). `endpoints` and `send`: where and through what each
 *  provider is asked (a test's fakes). `now`: the breakers' clock; `bounds`: a search's deadline and Firecrawl's inside
 *  it, and the guard check's bound; `log`: where a fetch notes what the model is not told. */
export type WebConfig = {
  order: { search: readonly SearchProvider[]; fetch: readonly FetchProvider[] };
  keys?: { parallel?: string };
  native?: NativeSearch;
  guard?: Guard;
  pay?: Pay;
  endpoints?: { "firecrawl-keyless"?: string };
  send?: Partial<Record<"parallel" | "firecrawl-keyless" | "exa-keyless", typeof fetch>>;
  words?: Words;
  now?: () => number;
  bounds?: SearchBounds & { checkMs?: number };
  log?: WebLog;
};
export type SearchOptions = { n?: number; signal?: AbortSignal };
export type FetchOptions = Part & { signal?: AbortSignal };
export type Web = {
  search(query: string, options?: SearchOptions): Promise<{ answer: Search; receipt: Receipt }>;
  fetch(url: string, options?: FetchOptions): Promise<{ answer: WebPage | Page; receipt: Receipt }>;
};

/** The fees of the requests sent within one call. */
const feesOfCall = new AsyncLocalStorage<Fee[]>();
const usd = (lines: Fee[]) => Math.round(lines.reduce((sum, fee) => sum + fee.usd, 0) * 1e6) / 1e6;
const outOf = (text: string) => ({ bytes: Buffer.byteLength(text), chars: text.length });
const judged = { classifier: "off", wall: { verdict: "unjudged" }, injection: "unjudged" } as const;

/** One run's Web on `config`. */
export function createWeb(config: WebConfig): Web {
  const now = config.now ?? Date.now;
  const breakerOf = breakers(now);
  const pages: Pages = new Map();
  // A fee goes on the call's receipt once its request is sent, whatever the cap then books.
  const pay: Pay = (fee, send) => (config.pay ?? unmetered)(fee, () => (feesOfCall.getStore()?.push(fee), send()));
  let parallel: Extract | null | undefined;
  const parallelOf = () => (parallel ??= config.keys?.parallel === undefined ? null : parallelExtract(config.keys.parallel, config.send?.parallel ?? fetch, pay));
  let firecrawl: KeylessFetch | undefined;
  const firecrawlOf = () => (firecrawl ??= firecrawlFetch({ ...(config.endpoints?.["firecrawl-keyless"] ? { endpoint: config.endpoints["firecrawl-keyless"] } : {}), ...(config.send?.["firecrawl-keyless"] ? { send: config.send["firecrawl-keyless"] } : {}), ...(config.words ? { words: config.words } : {}) }, now));
  return {
    async search(query, { n, signal } = {}) {
      const lines: Fee[] = [];
      const tries: Try[] = [];
      const answer = await feesOfCall.run(lines, () =>
        searchWith({ query, ...(n === undefined ? {} : { n }) }, {
          order: config.order.search,
          breakerOf,
          ...(signal ? { signal } : {}),
          ...(config.bounds ? { bounds: config.bounds } : {}),
          parallel: parallelOf,
          ...(config.native ? { native: config.native } : {}),
          firecrawl: { ...(config.endpoints?.["firecrawl-keyless"] ? { endpoint: config.endpoints["firecrawl-keyless"] } : {}), ...(config.send?.["firecrawl-keyless"] ? { send: config.send["firecrawl-keyless"] } : {}) },
          exa: config.send?.["exa-keyless"] ? { send: config.send["exa-keyless"] } : {},
          ...(config.words ? { words: config.words } : {}),
          tries,
        }),
      );
      const receipt: Receipt = { op: "search", asked: query, provider: "error" in answer ? null : answer.provider, tries, ...judged, out: outOf(searchText(answer)), cost: { usd: usd(lines), lines } };
      return { answer, receipt };
    },
    async fetch(url, { offset, maxChars, signal } = {}) {
      const lines: Fee[] = [];
      const tries: Try[] = [];
      // A part a call may not ask for is refused before anything is fetched, as serve's fetchFor refuses it.
      const problem = partProblem({ offset, maxChars });
      if (problem) {
        const refused: Page = { ok: false, url: clip(url, URL_MAX), status: 0, title: "", text: "", links: [], error: problem };
        return { answer: refused, receipt: { op: "fetch", asked: url, provider: null, tries, ...judged, out: outOf(webFetchText(refused)), cost: { usd: 0, lines } } };
      }
      const cached = pages.has(url);
      const log: WebLog = (event, fields) => {
        if (event === "web_fetch_firecrawl_failed") tries.push({ provider: "firecrawl-keyless", outcome: "error", ...(fields.said ? { error: fields.said } : {}) });
        config.log?.(event, fields);
      };
      const order = config.order.fetch;
      const extract = order.includes("parallel") ? parallelOf() : null;
      const page = await feesOfCall.run(lines, () =>
        webFetch(url, {
          parallel: extract,
          firecrawl: order.includes("firecrawl-keyless") ? firecrawlOf() : null,
          pages,
          order,
          ...(config.guard ? { guard: config.guard } : {}),
          ...(config.bounds?.checkMs === undefined ? {} : { checkMs: config.bounds.checkMs }),
          ...(offset === undefined ? {} : { offset }),
          ...(maxChars === undefined ? {} : { maxChars }),
          ...(signal ? { signal } : {}),
          log,
        }),
      );
      // Parallel in the order with no key: the page says so beside it, as serve's fetchFor says it.
      const answer: WebPage = order.includes("parallel") && !extract ? { ...page, parallel: "not tried: this run holds no Parallel key" } : page;
      if (!cached) {
        if (answer.parallel) tries.push({ provider: "parallel", outcome: "error", error: answer.parallel });
        if (answer.via !== "stopped" && answer.via !== "none") tries.push({ provider: answer.via, outcome: answer.ok ? "ok" : "error", ...(answer.ok ? {} : { error: answer.refused ?? answer.error ?? "" }) });
      }
      const provider = answer.ok && answer.via !== "stopped" && answer.via !== "none" ? answer.via : null;
      const receipt: Receipt = { op: "fetch", asked: url, provider, tries, ...judged, out: outOf(webFetchText(answer)), cost: { usd: usd(lines), lines }, ...(cached ? { cache: "hit" as const } : {}) };
      return { answer, receipt };
    },
  };
}
