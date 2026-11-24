// One run's web search and fetch (createWeb). The providers asked are data (WebConfig.order); everything from outside
// comes in through the config. Every answer comes with a Receipt, which is never put in front of the model.
import { AsyncLocalStorage } from "node:async_hooks";
import { type WebLog, type FetchProvider, type Pages, type WebPage, webFetchText, webPart, webRead } from "./fetch.js";
import { type Fee, type Pay, unmetered } from "./fees.js";
import type { Guard, GuardOptions } from "./guard.js";
import { clip, type Page, type Part, partProblem, URL_MAX } from "./page.js";
import { EXA_API_URL, exaClient, exaRead, exaSearched, type ExaSettings, exaSettingsProblems } from "./providers/exa.js";
import { exaLimitOf, exaSearch } from "./providers/exa-keyless.js";
import { FIRECRAWL_API_URL, firecrawlClient, firecrawlRead, firecrawlSearched, type FirecrawlSettings, firecrawlSettingsProblems } from "./providers/firecrawl.js";
import { firecrawlFetch, type FirecrawlOptions, firecrawlSearch, type KeylessFetch } from "./providers/firecrawl-keyless.js";
import { type Keyed, type KeyedFetch, keyedFetch } from "./providers/keyed.js";
import type { Words } from "./providers/mcp.js";
import { type Extract, parallelExtract, parallelSearched, type ParallelSettings, parallelSettingsProblems } from "./providers/parallel.js";
import type { WebDecider } from "./decide/decider.js";
import { type DecidePolicy, decisionPay, type DecisionRecord, findInPage, type FoundPage, judgePart, policyOf, siftSearch } from "./decide/step.js";
import { type Backend, type Breaker, breakers, fitSearch, type Limit, QUERY_MAX, type Search, type SearchBounds, type Searched, searchArgs, searchInTurn, searchText, type Try } from "./search.js";

export type ProviderId = "parallel" | "firecrawl-keyless" | "exa-keyless" | "exa" | "firecrawl" | "native" | "direct";
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

/** Each keyed provider's settings, typed with defaults (PARALLEL_DEFAULTS, EXA_DEFAULTS, FIRECRAWL_DEFAULTS). */
export type ProviderSettings = { parallel?: ParallelSettings; exa?: ExaSettings; firecrawl?: FirecrawlSettings };

/** `order.fetch` names the providers ahead of the direct fetch ("direct" in it). No key for a keyed provider in an order
 *  (`keys.parallel`, `keys.exa`, `keys.firecrawl`): it answers that the run holds none, unsent. `settings`: each keyed
 *  provider's (ProviderSettings); one a provider does not take throws here, before anything is sent. No `guard`:
 *  nothing is fetched directly and no URL goes to a provider. No `pay`: unmetered. */
export type WebConfig = {
  order: { search: readonly SearchProvider[]; fetch: readonly FetchProvider[] };
  keys?: { parallel?: string; exa?: string; firecrawl?: string };
  settings?: ProviderSettings;
  native?: NativeSearch;
  guard?: Guard;
  pay?: Pay;
  endpoints?: { "firecrawl-keyless"?: string; exa?: string; firecrawl?: string };
  send?: Partial<Record<"parallel" | "firecrawl-keyless" | "exa-keyless" | "exa" | "firecrawl", typeof fetch>>;
  words?: Words;
  now?: () => number;
  bounds?: SearchBounds & { checkMs?: number; decideMs?: number };
  log?: WebLog;
  /** Sifts each search's results and judges each fetched part; none: nothing is sifted, as before the step. */
  decider?: WebDecider;
  /** How a search's results reach the model once the decider has scored them ("drop" by default); checked when the
   *  web is made. */
  policy?: DecidePolicy;
};
/** `breakers`: the search breakers this call reads and trips (default the Web's own). `task`: what the caller needs,
 *  which a decider judges against (a search without one is judged on its query). */
export type SearchOptions = { n?: number; signal?: AbortSignal; breakers?: (name: string) => Breaker; task?: string };
/** `lookup` and `fetchImpl`: the resolver and transport this call's guard dials through. `lookingFor`: what the caller
 *  is looking for on the page (the tool's looking_for). With a decider, the answer is the chunks of the whole page most
 *  likely to hold it (findInPage), `offset` and `maxChars` aside; without one, or when the step fails, the part asked
 *  for, saying looking_for was not applied. Blank: none. */
export type FetchOptions = Part & GuardOptions & { task?: string; lookingFor?: string };
/** `sift`, only when a decider is given: what it did, for the model to read. */
export type Sift = { sift?: string };
export type Web = {
  search(query: string, options?: SearchOptions): Promise<{ answer: Search & Sift; receipt: Receipt }>;
  fetch(url: unknown, options?: FetchOptions): Promise<{ answer: ((WebPage | Page) & Sift) | FoundPage; receipt: Receipt }>;
};

/** The fees of the requests sent within one call. */
const feesOfCall = new AsyncLocalStorage<Fee[]>();
const usd = (lines: Fee[]) => Math.round(lines.reduce((sum, fee) => sum + fee.usd, 0) * 1e6) / 1e6;
const outOf = (text: string) => ({ bytes: Buffer.byteLength(text), chars: text.length });
const unjudged = { wall: { verdict: "unjudged" }, injection: "unjudged" } as const;
/** A provider's failure: the error alone for the model, the limit it met for the breaker. */
const failedWith = (error: string, limit: Searched["limit"]): Searched => ({ answer: { error }, ...(limit ? { limit } : {}) });

/** What is wrong with `settings`, one line each: a provider they name that takes none, or what its own check refuses. */
function settingsProblemsOf(settings: unknown): string[] {
  if (settings === undefined) return [];
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return ["settings must be an object of each provider's settings"];
  const checks: Record<string, (one: unknown) => string[]> = { parallel: parallelSettingsProblems, exa: exaSettingsProblems, firecrawl: firecrawlSettingsProblems };
  return Object.entries(settings).flatMap(([name, one]) => (one === undefined ? [] : checks[name]?.(one) ?? [`settings name ${name}, which takes no settings here (parallel, exa and firecrawl do)`]));
}

export function createWeb(config: WebConfig): Web {
  const problems = settingsProblemsOf(config.settings);
  if (problems.length) throw new Error(`web settings: ${problems.join("; ")}`);
  const settings = config.settings ?? {};
  const now = config.now ?? Date.now;
  const policy = policyOf(config.policy);
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
  const parallelOf = () => (parallel ??= config.keys?.parallel === undefined ? null : parallelExtract(config.keys.parallel, config.send?.parallel ?? fetch, pay, settings.parallel));
  let keyless: KeylessFetch | undefined;
  const firecrawlOf = () => (keyless ??= firecrawlFetch(firecrawl, now));
  // The keyed providers' clients (null: no key), each shared by both tools, so a key refused by one is refused by both.
  let exa_: Keyed | null | undefined;
  const exaOf = () => (exa_ === undefined ? (exa_ = config.keys?.exa === undefined ? null : exaClient(config.keys.exa, config.send?.exa ?? fetch, pay, config.endpoints?.exa ?? EXA_API_URL)) : exa_);
  let firecrawl_: Keyed | null | undefined;
  const keyedFirecrawlOf = () => (firecrawl_ === undefined ? (firecrawl_ = config.keys?.firecrawl === undefined ? null : firecrawlClient(config.keys.firecrawl, config.send?.firecrawl ?? fetch, pay, config.endpoints?.firecrawl ?? FIRECRAWL_API_URL)) : firecrawl_);
  let exaReader: KeyedFetch | undefined;
  const exaReaderOf = () => (exaReader ??= keyedFetch(exaOf(), (url, signal) => exaRead(url, exaOf(), settings.exa, signal), now));
  let firecrawlReader: KeyedFetch | undefined;
  const firecrawlReaderOf = () => (firecrawlReader ??= keyedFetch(keyedFirecrawlOf(), (url, signal) => firecrawlRead(url, keyedFirecrawlOf(), settings.firecrawl, signal), now));

  const backendOf = (name: SearchProvider, args: Record<string, unknown>, signal: AbortSignal | undefined): Backend => {
    const { query, n } = searchArgs(args);
    if (name === "parallel") return { name, ask: () => parallelSearched(args, parallelOf(), signal, settings.parallel) };
    // A keyed provider keeps the caller's signal and its own bound, as Parallel does: a paid request is not cut short by
    // the keyless providers' deadline.
    if (name === "exa") return { name, ask: () => exaSearched(args, exaOf(), settings.exa, signal) };
    if (name === "firecrawl") return { name, ask: () => firecrawlSearched(args, keyedFirecrawlOf(), settings.firecrawl, signal) };
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
      const sifted = config.decider ? await siftSearch(config.decider, found, { task, signal, ms: config.bounds?.decideMs, pay: decisionPay(config.pay ?? unmetered, lines), policy }) : { answer: found, classifier: "off" as const };
      const answer: Search & Sift = fitSearch(sifted.answer);
      const { classifier } = sifted;
      const receipt: Receipt = { op: "search", asked: query, provider: "error" in answer ? null : answer.provider, tries, classifier, ...unjudged, out: outOf(searchText(answer)), cost: { usd: usd(lines), lines } };
      return { answer, receipt };
    },
    async fetch(url, { offset, maxChars, task, lookingFor, ...guarded } = {}) {
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
        if (event === "web_fetch_provider_failed" && fields.provider) tries.push({ provider: fields.provider, outcome: "error", error: fields.said ?? "", ...(fields.limit ? { limit: JSON.parse(fields.limit) as Limit } : {}) });
        config.log?.(event, fields);
      };
      const order = config.order.fetch;
      const extract = order.includes("parallel") ? parallelOf() : null;
      const read = await feesOfCall.run(lines, () =>
        webRead(url, {
          ...guarded,
          parallel: extract,
          firecrawl: order.includes("firecrawl-keyless") ? firecrawlOf() : null,
          keyed: { exa: order.includes("exa") ? exaReaderOf() : null, firecrawl: order.includes("firecrawl") ? firecrawlReaderOf() : null },
          pages,
          order,
          ...(config.guard ? { guard: config.guard } : {}),
          ...(config.bounds?.checkMs === undefined ? {} : { checkMs: config.bounds.checkMs }),
          log,
        }),
      );
      const whole = order.includes("parallel") && !extract ? { ...read, parallel: "not tried: this run holds no Parallel key" } : read;
      const part = webPart(whole, { ...(offset === undefined ? {} : { offset }), ...(maxChars === undefined ? {} : { maxChars }) });
      if (!cached) {
        if (part.parallel) tries.push({ provider: "parallel", outcome: "error", error: part.parallel });
        if (part.via !== "stopped" && part.via !== "none") tries.push({ provider: part.via, outcome: part.ok ? "ok" : "error", ...(part.ok ? {} : { error: part.refused ?? part.error ?? "" }) });
      }
      const provider = part.ok && part.via !== "stopped" && part.via !== "none" ? part.via : null;
      const step = { signal: guarded.signal, ms: config.bounds?.decideMs, pay: decisionPay(config.pay ?? unmetered, lines) };
      const need = typeof lookingFor === "string" ? clip(lookingFor.trim(), QUERY_MAX) : "";
      const notApplied = (why: string) => ({ ...part, sift: `looking_for not applied (${why}); this part is in page order` });
      let answer: ((WebPage | Page) & Sift) | FoundPage = part;
      let classifier: Receipt["classifier"] = "off";
      if (need && whole.ok && whole.text && config.decider) {
        const found = await findInPage(config.decider, asked, whole, need, step);
        answer = found.answer ?? notApplied(found.classifier.error!.code);
        classifier = found.classifier;
      } else if (need && whole.ok && whole.text) answer = notApplied("no classifier in this run");
      else if (config.decider) ({ answer, classifier } = await judgePart(config.decider, asked, part, { task, ...step }));
      const receipt: Receipt = { op: "fetch", asked, provider, tries, classifier, ...unjudged, out: outOf(webFetchText(answer)), cost: { usd: usd(lines), lines }, ...(cached ? { cache: "hit" as const } : {}) };
      return { answer, receipt };
    },
  };
}
