// One run's web search and fetch (createWeb). The providers asked are data (WebConfig.order); everything from outside
// comes in through the config. Every answer comes with a Receipt, which is never put in front of the model.
import { AsyncLocalStorage } from "node:async_hooks";
import type { WebDecider } from "./decide/decider.js";
import { type DecidePolicy, decisionPay, type DecisionRecord, findInPage, type FoundPage, judgePart, policyOf, siftSearch } from "./decide/step.js";
import { missesOf, type Pages, type Readers, type WebLog, type WebPage, webFetchText, webPart, webRead } from "./fetch.js";
import { type Fee, type Pay, unmetered } from "./fees.js";
import type { Guard, GuardOptions } from "./guard.js";
import { clip, type Page, type Part, partProblem, URL_MAX } from "./page.js";
import { holdingWords, type NativeSearch, type ProviderRun, readerOf } from "./provider.js";
import type { Words } from "./providers/mcp.js";
import { type FetchProvider, type KeyedProvider, type ProviderId, providerOf, type ProviderSettings, type SearchProvider, settingsProblemsOf } from "./providers/registry.js";
import { type Breaker, breakers, fitSearch, type Holding, withKeyBreaker, QUERY_MAX, type Search, type SearchBounds, searchArgs, searchInTurn, searchText, type Try } from "./search.js";

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

/** `order` names the providers each tool asks, in turn, by their registry ids (providers/registry.ts); `order.fetch`
 *  ends with "direct" where a page may be fetched directly. An id no provider has, or a provider for a tool it does not
 *  serve, throws here. No key for a keyed provider in an order (`keys`): it answers that the run holds none, unsent.
 *  `settings`: a provider's, by its id (ProviderSettings); one a provider does not take throws here, before anything is
 *  sent. No `guard`: nothing is fetched directly and no URL goes to a provider. No `pay`: unmetered. `endpoints` and
 *  `send`: where a provider's requests go, and through what, by its id. */
export type WebConfig = {
  order: { search: readonly SearchProvider[]; fetch: readonly FetchProvider[] };
  keys?: Partial<Record<KeyedProvider, string>>;
  settings?: ProviderSettings;
  native?: NativeSearch;
  guard?: Guard;
  pay?: Pay;
  endpoints?: Partial<Record<ProviderId, string>>;
  send?: Partial<Record<ProviderId, typeof fetch>>;
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
/** `breakers`: the search breakers this call reads and trips (default the Web's own). `keyLimits`: where a quota of a
 *  provider's whole key goes (search.ts Failure.covers): the Web's key breakers, shared with web_fetch ("web", the
 *  default without `breakers`), or the call's own breakers ("call", the default with them). `task`: what the caller
 *  needs, which a decider judges against (a search without one is judged on its query). */
export type SearchOptions = { n?: number; signal?: AbortSignal; breakers?: (name: string) => Breaker; keyLimits?: "web" | "call"; task?: string };
/** `lookup` and `fetchImpl`: the resolver and transport this call's guard dials through. `lookingFor`: what the caller
 *  is looking for on the page (the tool's looking_for). With a decider, the answer is the chunks of the whole page most
 *  likely to hold it (findInPage), `offset` and `maxChars` aside; without one, or when the step fails, the part asked
 *  for, saying looking_for was not applied. Blank: none. */
export type FetchOptions = Part & GuardOptions & { task?: string; lookingFor?: string };
/** `sift`, only when a decider is given: what it did, for the model to read. */
export type Sift = { sift?: string };
/** A provider a Web's tool asks: its id, how it is reached (`keyed`, on the run's key; `unkeyed`, a keyed provider the
 *  run holds no key for, so never sent; `keyless`, a service's free use; `none`, neither: the model provider's own search
 *  or the guarded direct fetch), and what holds it now (the tool's breaker, else its key's), if anything. */
export type Destination = { id: ProviderId; access: "keyed" | "unkeyed" | "keyless" | "none"; held?: Holding };
/** Each tool's providers, in the order it asks them. */
export type Destinations = { search: Destination[]; fetch: Destination[] };
/** `destinations`: where each tool goes now (Destinations), for a run's start line; never a key. */
export type Web = {
  search(query: string, options?: SearchOptions): Promise<{ answer: Search & Sift; receipt: Receipt }>;
  fetch(url: unknown, options?: FetchOptions): Promise<{ answer: ((WebPage | Page) & Sift) | FoundPage; receipt: Receipt }>;
  destinations(): Destinations;
};

/** One tool's destinations in words: each id, how it is reached, and what holds it ("none" for an empty order). */
const toolWords = (order: readonly Destination[]): string =>
  order.map(({ id, access, held }) => {
    const notes = [...(access === "none" ? [] : [access === "unkeyed" ? "keyed, no key" : access]), ...(held ? [holdingWords(held)] : [])];
    return notes.length ? `${id} (${notes.join(", ")})` : id;
  }).join(" > ") || "none";
/** Each tool's destinations in words, for a log line's fields. */
export const destinationsWords = ({ search, fetch }: Destinations): { search: string; fetch: string } => ({ search: toolWords(search), fetch: toolWords(fetch) });
/** Both tools' destinations on one line: "search: …; fetch: …". */
export function destinationsLine(destinations: Destinations): string {
  const { search, fetch } = destinationsWords(destinations);
  return `search: ${search}; fetch: ${fetch}`;
}

/** The fees of the requests sent within one call. */
const feesOfCall = new AsyncLocalStorage<Fee[]>();
const usd = (lines: Fee[]) => Math.round(lines.reduce((sum, fee) => sum + fee.usd, 0) * 1e6) / 1e6;
const outOf = (text: string) => ({ bytes: Buffer.byteLength(text), chars: text.length });
const unjudged = { wall: { verdict: "unjudged" }, injection: "unjudged" } as const;

export function createWeb(config: WebConfig): Web {
  const problems = settingsProblemsOf(config.settings);
  if (problems.length) throw new Error(`web settings: ${problems.join("; ")}`);
  for (const op of ["search", "fetch"] as const) for (const id of config.order[op]) if (!providerOf(id).ops.includes(op)) throw new Error(`web: ${id} gives no ${op}`);
  const now = config.now ?? Date.now;
  const policy = policyOf(config.policy);
  const runBreakers = breakers(now);
  const fetchBreakers = breakers(now);
  // Each provider's own across both tools: a quota of the whole key holds web_search and web_fetch alike.
  const keyBreakers = breakers(now);
  const pages: Pages = new Map();
  // A fee goes on the call's receipt once its request is sent, whatever the cap then books.
  const pay: Pay = (fee, send) => (config.pay ?? unmetered)(fee, () => (feesOfCall.getStore()?.push(fee), send()));

  // Each provider an order names is made once per Web, at its first use, from the run's parts for it: one client a
  // provider, so a key refused by one tool is refused by both.
  const runs = new Map<ProviderId, ProviderRun>();
  const runOf = (id: ProviderId): ProviderRun => {
    let run = runs.get(id);
    if (!run) {
      const key = (config.keys as Partial<Record<string, string>> | undefined)?.[id];
      const endpoint = config.endpoints?.[id];
      const send = config.send?.[id];
      const settings = (config.settings as Partial<Record<string, unknown>> | undefined)?.[id];
      run = providerOf(id).make({
        ...(key === undefined ? {} : { key }),
        ...(endpoint ? { endpoint } : {}),
        ...(send ? { send } : {}),
        ...(settings === undefined ? {} : { settings }),
        ...(config.guard ? { guard: config.guard } : {}),
        ...(config.words ? { words: config.words } : {}),
        ...(config.native ? { native: config.native } : {}),
        ...(config.bounds ? { bounds: config.bounds } : {}),
        pay,
        now,
      });
      runs.set(id, run);
    }
    return run;
  };
  let readers: Readers | undefined;
  // A provider that ends the order is made by webRead for each read, never here.
  const readersOf = (): Readers => (readers ??= Object.fromEntries(config.order.fetch.filter((id) => !providerOf(id).fetch?.ends).map((id) => [id, readerOf(runOf(id), withKeyBreaker(fetchBreakers(id), keyBreakers(id)))])));

  const destinationOf = (id: ProviderId, own: (name: string) => Breaker): Destination => {
    const provider = providerOf(id);
    const keyed = (config.keys as Partial<Record<string, string>> | undefined)?.[id] !== undefined;
    const access = provider.key ? (keyed ? "keyed" : "unkeyed") : provider.keyless ? "keyless" : "none";
    const held = withKeyBreaker(own(id), keyBreakers(id)).holding();
    return { id, access, ...(held ? { held } : {}) };
  };

  return {
    destinations: () => ({ search: config.order.search.map((id) => destinationOf(id, runBreakers)), fetch: config.order.fetch.map((id) => destinationOf(id, fetchBreakers)) }),
    async search(query, { n, signal, breakers: given, keyLimits = given ? "call" : "web", task } = {}) {
      const ownOf = given ?? runBreakers;
      const breakerOf = (name: string) => withKeyBreaker(ownOf(name), keyLimits === "web" ? keyBreakers(name) : ownOf(`${name} key`));
      const lines: Fee[] = [];
      const tries: Try[] = [];
      const ask = searchArgs({ query, ...(n === undefined ? {} : { n }) });
      const order = config.order.search;
      // No provider is asked an empty query.
      const found: Search = !ask.query ? { error: "web_search needs a query" }
        : !order.length ? { error: "web_search has no provider to ask" }
        : await feesOfCall.run(lines, () => searchInTurn(order.map((id) => ({ name: id, ask: (deadline: AbortSignal) => runOf(id).search!(ask, deadline, signal) })), breakerOf, signal, config.bounds?.searchMs, tries));
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
      const whole = await feesOfCall.run(lines, () =>
        webRead(url, {
          ...guarded,
          readers: readersOf(),
          pages,
          order: config.order.fetch,
          ...(config.guard ? { guard: config.guard } : {}),
          ...(config.bounds?.checkMs === undefined ? {} : { checkMs: config.bounds.checkMs }),
          ...(config.log ? { log: config.log } : {}),
          tries,
        }),
      );
      const part = webPart(whole, { ...(offset === undefined ? {} : { offset }), ...(maxChars === undefined ? {} : { maxChars }) });
      const provider = part.ok && part.via !== "stopped" && part.via !== "none" ? part.via : null;
      const step = { signal: guarded.signal, ms: config.bounds?.decideMs, pay: decisionPay(config.pay ?? unmetered, lines) };
      const need = typeof lookingFor === "string" ? clip(lookingFor.trim(), QUERY_MAX) : "";
      const notApplied = (why: string) => ({ ...part, sift: `looking_for not applied (${why}); this part is in page order` });
      let answer: ((WebPage | Page) & Sift) | FoundPage = part;
      let classifier: Receipt["classifier"] = "off";
      if (need && whole.ok && whole.text && config.decider) {
        const found = await findInPage(config.decider, asked, whole, need, step);
        answer = found.answer ? { ...found.answer, ...missesOf(whole) } : notApplied(found.classifier.error!.code);
        classifier = found.classifier;
      } else if (need && whole.ok && whole.text) answer = notApplied("no classifier in this run");
      else if (config.decider) ({ answer, classifier } = await judgePart(config.decider, asked, part, { task, ...step }));
      // The turns a stopped call's read takes after it answered are not this receipt's.
      const receipt: Receipt = { op: "fetch", asked, provider, tries: [...tries], classifier, ...unjudged, out: outOf(webFetchText(answer)), cost: { usd: usd(lines), lines }, ...(cached ? { cache: "hit" as const } : {}) };
      return { answer, receipt };
    },
  };
}
