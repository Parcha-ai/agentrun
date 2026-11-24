// One run's web search and fetch (createWeb). The providers asked are data (WebConfig.order); everything from outside
// comes in through the config. Every answer comes with a Receipt, which is never put in front of the model.
import { AsyncLocalStorage } from "node:async_hooks";
import { type WebLog, type FetchProvider, type Pages, type WebPage, webFetch, webFetchText } from "./fetch.js";
import { type Fee, type Pay, unmetered } from "./fees.js";
import type { Guard, GuardOptions } from "./guard.js";
import { clip, type Page, type Part, partProblem, URL_MAX } from "./page.js";
import { exaLimitOf, exaSearch } from "./providers/exa-keyless.js";
import { firecrawlFetch, type FirecrawlOptions, firecrawlSearch, type KeylessFetch } from "./providers/firecrawl-keyless.js";
import type { Words } from "./providers/mcp.js";
import { type Extract, parallelExtract, parallelSearched } from "./providers/parallel.js";
import type { WebDecider } from "./decide/decider.js";
import { type DecisionRecord, judgePart, siftSearch } from "./decide/step.js";
import { type Backend, type Breaker, breakers, fitSearch, type Search, type SearchBounds, type Searched, searchArgs, searchInTurn, searchText, type Try } from "./search.js";

export type ProviderId = "parallel" | "firecrawl-keyless" | "exa-keyless" | "native" | "direct";
export type SearchProvider = Exclude<ProviderId, "direct">;
/** The run's own model provider's hosted search. `signal` is the caller's; it keeps its own bounds. */
export type NativeSearch = (query: string, n: number, signal?: AbortSignal) => Promise<Searched>;

/** What an answer took and cost. `out` is the answer as the model reads it; `cache` is "hit" when a fetch came from the
 *  run's pages. */
export type Receipt = {
  op: "search" | "fetch";
  asked: string;
  provider: ProviderId | null;
  tries: Try[];
  classifier: "off" | DecisionRecord;
  wall: { verdict: "unjudged" };
  injection: "unjudged";
  out: { bytes: number; chars: number };
  cost: { usd: number; lines: Fee[] };
  cache?: "hit";
};

/** `order.fetch` names the providers ahead of the direct fetch ("direct" in it). No `keys.parallel`: Parallel answers
 *  that the run holds none. No `guard`: nothing is fetched directly and no URL goes to a provider. No `pay`: unmetered. */
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
  bounds?: SearchBounds & { checkMs?: number; decideMs?: number };
  log?: WebLog;
  /** Sifts each search's results and judges each fetched part; none: nothing is sifted, as before the step. */
  decider?: WebDecider;
};
/** `breakers`: the search breakers this call reads and trips (default the Web's own). `task`: what the caller needs,
 *  which a decider judges against (a search without one is judged on its query). */
export type SearchOptions = { n?: number; signal?: AbortSignal; breakers?: (name: string) => Breaker; task?: string };
/** `lookup` and `fetchImpl`: the resolver and transport this call's guard dials through. */
export type FetchOptions = Part & GuardOptions & { task?: string };
/** `sift`, only when a decider is given: what it did, for the model to read. */
export type Sift = { sift?: string };
export type Web = {
  search(query: string, options?: SearchOptions): Promise<{ answer: Search & Sift; receipt: Receipt }>;
  fetch(url: unknown, options?: FetchOptions): Promise<{ answer: (WebPage | Page) & Sift; receipt: Receipt }>;
};

/** The fees of the requests sent within one call. */
const feesOfCall = new AsyncLocalStorage<Fee[]>();
const usd = (lines: Fee[]) => Math.round(lines.reduce((sum, fee) => sum + fee.usd, 0) * 1e6) / 1e6;
const outOf = (text: string) => ({ bytes: Buffer.byteLength(text), chars: text.length });
const unjudged = { wall: { verdict: "unjudged" }, injection: "unjudged" } as const;
/** A provider's failure: the error alone for the model, the limit it met for the breaker. */
const failedWith = (error: string, limit: Searched["limit"]): Searched => ({ answer: { error }, ...(limit ? { limit } : {}) });

export function createWeb(config: WebConfig): Web {
  const now = config.now ?? Date.now;
  const runBreakers = breakers(now);
  const pages: Pages = new Map();
  // A fee goes on the call's receipt once its request is sent, whatever the cap then books.
  const pay: Pay = (fee, send) => (config.pay ?? unmetered)(fee, () => (feesOfCall.getStore()?.push(fee), send()));

  const firecrawl: Omit<FirecrawlOptions, "signal"> = {};
  const exa: { send?: typeof fetch; words?: Words } = {};
  if (config.endpoints?.["firecrawl-keyless"]) firecrawl.endpoint = config.endpoints["firecrawl-keyless"];
  if (config.send?.["firecrawl-keyless"]) firecrawl.send = config.send["firecrawl-keyless"];
  if (config.send?.["exa-keyless"]) exa.send = config.send["exa-keyless"];
  if (config.words) firecrawl.words = exa.words = config.words;
  firecrawl.now = now;
  const firecrawlSearchMs = config.bounds?.firecrawlMs;

  let parallel: Extract | null | undefined;
  const parallelOf = () => (parallel ??= config.keys?.parallel === undefined ? null : parallelExtract(config.keys.parallel, config.send?.parallel ?? fetch, pay));
  let keyless: KeylessFetch | undefined;
  const firecrawlOf = () => (keyless ??= firecrawlFetch(firecrawl, now));

  const backendOf = (name: SearchProvider, args: Record<string, unknown>, signal: AbortSignal | undefined): Backend => {
    const { query, n } = searchArgs(args);
    if (name === "parallel") return { name, ask: () => parallelSearched(args, parallelOf(), signal) };
    if (name === "native") return { name, ask: async () => (config.native ? config.native(query, n, signal) : { answer: { error: "web_search: no native search was given" } }) };
    if (name === "firecrawl-keyless") {
      return { name, ask: async (deadline) => {
        const found = await firecrawlSearch(query, n, { ...firecrawl, signal: deadline, ...(firecrawlSearchMs === undefined ? {} : { timeoutMs: firecrawlSearchMs }) });
        // Which limit Firecrawl met is the breaker's to read, never the model's.
        return "error" in found ? failedWith(found.error, "limit" in found ? found.limit : undefined) : { answer: found };
      } };
    }
    return { name, ask: async (deadline) => {
      const found = await exaSearch(query, n, { ...exa, signal: deadline });
      return "limit" in found ? failedWith(found.error, exaLimitOf(found)) : { answer: found };
    } };
  };

  return {
    async search(query, { n, signal, breakers: breakerOf = runBreakers, task } = {}) {
      const lines: Fee[] = [];
      const tries: Try[] = [];
      const args = { query, ...(n === undefined ? {} : { n }) };
      const order = config.order.search;
      // Parallel's search answers an empty query itself; every other provider is asked only with one.
      const found: Search = !order.includes("parallel") && !searchArgs(args).query ? { error: "web_search needs a query" }
        : !order.length ? { error: "web_search has no provider to ask" }
        : await feesOfCall.run(lines, () => searchInTurn(order.map((name) => backendOf(name, args, signal)), breakerOf, signal, config.bounds?.searchMs, tries));
      // Sifted before it is fitted, so the fit sees only the kept results; fitSearch keeps every other field.
      const sifted = config.decider ? await siftSearch(config.decider, found, { task, signal, ms: config.bounds?.decideMs }) : { answer: found, classifier: "off" as const };
      const answer: Search & Sift = fitSearch(sifted.answer);
      const { classifier } = sifted;
      const receipt: Receipt = { op: "search", asked: query, provider: "error" in answer ? null : answer.provider, tries, classifier, ...unjudged, out: outOf(searchText(answer)), cost: { usd: usd(lines), lines } };
      return { answer, receipt };
    },
    async fetch(url, { offset, maxChars, task, ...guarded } = {}) {
      const asked = typeof url === "string" ? url : "";
      const lines: Fee[] = [];
      const tries: Try[] = [];
      // A part a call may not ask for is refused before anything is fetched.
      const problem = partProblem({ offset, maxChars });
      if (problem) {
        const refused: Page = { ok: false, url: clip(asked, URL_MAX), status: 0, title: "", text: "", links: [], error: problem };
        const classifier = config.decider ? (await judgePart(config.decider, asked, refused, {})).classifier : "off";
        return { answer: refused, receipt: { op: "fetch", asked, provider: null, tries, classifier, ...unjudged, out: outOf(webFetchText(refused)), cost: { usd: 0, lines } } };
      }
      const cached = typeof url === "string" && pages.has(url);
      const log: WebLog = (event, fields) => {
        if (event === "web_fetch_firecrawl_failed") tries.push({ provider: "firecrawl-keyless", outcome: "error", ...(fields.said ? { error: fields.said } : {}) });
        config.log?.(event, fields);
      };
      const order = config.order.fetch;
      const extract = order.includes("parallel") ? parallelOf() : null;
      const page = await feesOfCall.run(lines, () =>
        webFetch(url, {
          ...guarded,
          parallel: extract,
          firecrawl: order.includes("firecrawl-keyless") ? firecrawlOf() : null,
          pages,
          order,
          ...(config.guard ? { guard: config.guard } : {}),
          ...(config.bounds?.checkMs === undefined ? {} : { checkMs: config.bounds.checkMs }),
          ...(offset === undefined ? {} : { offset }),
          ...(maxChars === undefined ? {} : { maxChars }),
          log,
        }),
      );
      const read: WebPage = order.includes("parallel") && !extract ? { ...page, parallel: "not tried: this run holds no Parallel key" } : page;
      if (!cached) {
        if (read.parallel) tries.push({ provider: "parallel", outcome: "error", error: read.parallel });
        if (read.via !== "stopped" && read.via !== "none") tries.push({ provider: read.via, outcome: read.ok ? "ok" : "error", ...(read.ok ? {} : { error: read.refused ?? read.error ?? "" }) });
      }
      const provider = read.ok && read.via !== "stopped" && read.via !== "none" ? read.via : null;
      const signal = guarded.signal;
      const { answer, classifier } = config.decider ? await judgePart(config.decider, asked, read, { task, signal, ms: config.bounds?.decideMs }) : { answer: read, classifier: "off" as const };
      const receipt: Receipt = { op: "fetch", asked, provider, tries, classifier, ...unjudged, out: outOf(webFetchText(answer)), cost: { usd: usd(lines), lines }, ...(cached ? { cache: "hit" as const } : {}) };
      return { answer, receipt };
    },
  };
}
