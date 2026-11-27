// One run's web search and fetch (createWeb). The providers asked are data (WebConfig.order); everything from outside
// comes in through the config. Every answer comes with a Receipt, which is never put in front of the model.
import { AsyncLocalStorage } from "node:async_hooks";
import type { WebDecider } from "./decide/decider.js";
import { decideFetch, type FetchAnswer, judgePart } from "./decide/fetch.js";
import { guardPage, type InjectionVerdict, type PageGuard, type WallVerdict } from "./decide/page-guard.js";
import { decisionPay, type DecisionRecord, heldOnRefusal, type Sift, type StepOptions } from "./decide/record.js";
import { type DecidePolicy, policyOf, siftSearch } from "./decide/search.js";
import { missesOf, pageKey, type Pages, type Readers, sharedRead, type WebLog, type WebRead, webFetchText, webPart, webRead } from "./fetch.js";
import { type Fee, type Pay, unmetered, unsentOf } from "./fees.js";
import type { Guard, GuardOptions } from "./guard.js";
import { askedUrl, type Page, type Part, partProblem } from "./page.js";
import { holdingWords, type NativeSearch, type ProviderRun, readerOf, type WebClient } from "./provider.js";
import type { Words } from "./providers/mcp.js";
import { kindOf } from "./providers/keyed.js";
import { type FetchProvider, type KeyedProvider, type ProviderId, providerOf, type ProviderSettings, type SearchProvider, settingsProblemsOf } from "./providers/registry.js";
import { type Breaker, breakers, fitSearch, type Holding, type Limit, withKeyBreaker, type Search, type SearchBounds, searchArgs, searchInTurn, searchText, type Try } from "./search.js";

/** What an answer took and cost. `asked`: a search's objective, a fetch's URL as its page names it (no user name or
 *  password); `queries`, a search's keyword queries.
 *  `out` is the answer as the model reads it; `cache` is "hit" when a fetch came from the run's pages. */
export type Receipt = {
  op: "search" | "fetch";
  asked: string;
  queries?: string[];
  provider: ProviderId | null;
  tries: Try[];
  classifier: "off" | DecisionRecord;
  /** The page guard's verdicts on a fetched page, when `pageGuard` is on; "unjudged" otherwise. */
  wall: WallVerdict;
  injection: InjectionVerdict;
  out: { bytes: number; chars: number };
  cost: { usd: number; lines: Fee[] };
  cache?: "hit";
  /** With a classifier in the run: the text a web with none would have given the model for this call (a fetch's part
   *  as asked, without its objective), set beside what it read to see what the step saved. */
  unsifted?: string;
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
  /** Holds known before the Web is made (Hold): each holds its breaker from the start, the Web's and a call's own alike;
   *  one already over holds nothing. */
  holds?: readonly Hold[];
  /** Given each limit a breaker reads that leaves it holding (Hold): the tool's, or its key's. */
  onHold?: (hold: Hold) => void;
  /** Sifts each search's results and judges each fetched part; none: nothing is sifted, as before the step. */
  decider?: WebDecider;
  /** How a search's results reach the model once the decider has scored them ("drop" by default); checked when the
   *  web is made. */
  policy?: DecidePolicy;
  /** The page guard: with a decider, each page a fetch reads is asked once a run whether it is a wall or holds
   *  instructions addressed to an AI reader. Off unless true; true without a decider throws. */
  pageGuard?: boolean;
  /** The agent calling the web tools, as far as the run knows it: told to a provider that takes it (Parallel's search). */
  client?: WebClient;
};
/** `n`: how many results, where the search asked names none. `breakers`: the search breakers this call reads and trips
 *  (default the Web's own). `keyLimits`: where a quota of a provider's whole key goes (search.ts Failure.covers): the
 *  Web's key breakers, shared with web_fetch ("web", the default without `breakers`), or the call's own breakers
 *  ("call", the default with them). `task`: what the caller needs, which a decider judges against (a search without
 *  one is judged on its objective). `bounds`: this call's deadlines, each in place of the Web's (WebConfig.bounds)
 *  where given. `session`: this call's session, told to a provider that takes one in place of WebConfig.client's. */
export type SearchOptions = { n?: number; signal?: AbortSignal; breakers?: (name: string) => Breaker; keyLimits?: "web" | "call"; task?: string; bounds?: SearchBounds; session?: string };
/** `lookup` and `fetchImpl`: the resolver and transport this call's guard dials through. `objective`: what the caller
 *  wants from the page (the tool's objective); `lookingFor`, the same under its older name, read where no objective is
 *  given. With a decider, the answer is the chunks of the whole page most likely to hold it (findInPage), `offset` and
 *  `maxChars` aside; when the step fails, the part asked for, saying the objective was not applied; with no decider, the
 *  part asked for, as with none. Blank: none. `session`: this call's session, told to a provider that takes one in place
 *  of WebConfig.client's, as SearchOptions.session (a page the run already read is not read again). */
export type FetchOptions = Part & GuardOptions & { task?: string; objective?: string; lookingFor?: string; session?: string };
/** A provider a Web's tool asks: its id, how it is reached (`keyed`, on the run's key; `unkeyed`, a keyed provider the
 *  run holds no key for, so never sent; `keyless`, a service's free use; `none`, neither: the model provider's own search
 *  or the guarded direct fetch), and what holds it now (the tool's breaker, else its key's), if anything. */
export type Destination = { id: ProviderId; access: "keyed" | "unkeyed" | "keyless" | "none"; held?: Holding };
/** A provider's breaker for `tool` ("key": its key's, across both tools) holding as `kind` until `until` (epoch ms;
 *  Infinity: for the Web's life). */
export type Hold = { provider: ProviderId; tool: "search" | "fetch" | "key"; kind: Limit["kind"]; until: number };
/** Each tool's providers, in the order it asks them. */
export type Destinations = { search: Destination[]; fetch: Destination[] };
/** What a search asks: `{objective, queries?, n?}`, or a query alone (a string, or the deprecated `{query}`), which is
 *  searched as the objective and the one query (searchArgs). */
export type SearchInput = string | { objective?: string; queries?: readonly string[]; query?: string; n?: number };
/** `search`'s answer carries `sift` only when a decider is given: what it did, for the model to read. `destinations`:
 *  where each tool goes now (Destinations), for a run's start line; never a key. */
export type Web = {
  search(input: SearchInput, options?: SearchOptions): Promise<{ answer: Search & Sift; receipt: Receipt }>;
  fetch(url: unknown, options?: FetchOptions): Promise<{ answer: FetchAnswer; receipt: Receipt }>;
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

/** `shared`, a guard check another call started, or as soon as `signal` stops this call, the page left unjudged as a
 *  stopped check leaves it (code "aborted"). The shared check is not stopped: another call may still need it. */
function guardUntilStopped(shared: Promise<PageGuard>, signal?: AbortSignal): Promise<PageGuard> {
  if (!signal) return shared;
  const stopped = (): PageGuard => ({ wall: { verdict: "unjudged", error: { code: "aborted", message: String((signal.reason as Error)?.message ?? signal.reason).slice(0, 500) } }, injection: "unjudged" });
  if (signal.aborted) return Promise.resolve(stopped());
  return new Promise((resolve, reject) => {
    const onStop = () => resolve(stopped());
    signal.addEventListener("abort", onStop, { once: true });
    shared.then(
      (guard) => (signal.removeEventListener("abort", onStop), resolve(guard)),
      (error: unknown) => (signal.removeEventListener("abort", onStop), reject(error)),
    );
  });
}

export function createWeb(config: WebConfig): Web {
  const problems = settingsProblemsOf(config.settings);
  if (problems.length) throw new Error(`web settings: ${problems.join("; ")}`);
  for (const op of ["search", "fetch"] as const) for (const id of config.order[op]) if (!providerOf(id).ops.includes(op)) throw new Error(`web: ${id} gives no ${op}`);
  const now = config.now ?? Date.now;
  const policy = policyOf(config.policy);
  if (config.pageGuard !== undefined && typeof config.pageGuard !== "boolean") throw new TypeError(`pageGuard must be true or false (it was ${kindOf(config.pageGuard)})`);
  if (config.pageGuard && !config.decider) throw new TypeError("pageGuard needs a decider: the page guard asks the run's decider about each page");
  // The decider as this Web asks it: held for the Web's life once it refuses its key or its account.
  const held = config.decider ? heldOnRefusal(config.decider) : undefined;
  /** The page guard's verdict on each read the run's pages hold, kept with the read: it goes when the page is evicted,
   *  and a page read again is asked about again, as is one whose guard failed. */
  const pageVerdicts = new WeakMap<WebRead, Promise<PageGuard>>();
  const guardOf = (decider: WebDecider, url: string, read: WebRead, step: StepOptions): Promise<PageGuard> => {
    // One verdict a page: a read another fragment of its URL shares is that page (sharedRead).
    const page = sharedRead(read);
    const known = pageVerdicts.get(page);
    // A later caller waits on the check another started only until its own signal stops it; the check goes on.
    if (known) return guardUntilStopped(known, step.signal);
    const asked = guardPage(decider, url, read, step);
    pageVerdicts.set(page, asked);
    void asked.then((verdict) => verdict.wall.error && pageVerdicts.delete(page));
    return asked;
  };
  /** A receipt's `unsifted`, only in a run with a classifier. */
  const unsifted = (text: () => string) => (config.decider ? { unsifted: text() } : {});
  const runBreakers = breakers(now);
  const fetchBreakers = breakers(now);
  // Each provider's own across both tools: a quota of the whole key holds web_search and web_fetch alike.
  const keyBreakers = breakers(now);
  const pages: Pages = new Map();
  // Each breaker takes the holds known at the start once, at its first use: the Web's, and each a call brings.
  const seeded = new WeakSet<Breaker>();
  const watched = (tool: Hold["tool"], provider: ProviderId, breaker: Breaker): Breaker => {
    if (!seeded.has(breaker)) {
      seeded.add(breaker);
      for (const hold of config.holds ?? []) {
        const at = now();
        if (hold.provider !== provider || hold.tool !== tool || !(hold.until > at)) continue;
        const limit: Limit = hold.until === Number.POSITIVE_INFINITY ? { kind: hold.kind } : { kind: hold.kind, retryAfter: (hold.until - at) / 1_000 };
        breaker.read({ answer: { error: "held" }, limit });
      }
    }
    if (!config.onHold) return breaker;
    const onHold = config.onHold;
    return {
      ...breaker,
      read(searched) {
        const answer = breaker.read(searched);
        const holding = searched.limit ? breaker.holding() : undefined;
        if (holding) onHold({ provider, tool, ...holding });
        return answer;
      },
    };
  };
  const toolBreaker = (tool: "search" | "fetch", id: ProviderId, own: Breaker, key: Breaker): Breaker => withKeyBreaker(watched(tool, id, own), watched("key", id, key));
  // A fee goes on the call's receipt once its request is sent, whatever the cap then books. One that never left (its send
  // answered unsentAnswer, which the cap settles at $0) is $0 on it, saying so, as decisionPay's line for an unbilled
  // request is, once the cap's settle is written: a settle that failed leaves the line at the hold, as the cap keeps it.
  const pay: Pay = async (fee, send) => {
    const lines = feesOfCall.getStore();
    let at = -1;
    let unsent: string | undefined;
    let booked = true;
    const answer = await (config.pay ?? unmetered)(fee, async () => {
      if (lines) at = lines.push(fee) - 1;
      const response = await send();
      unsent = unsentOf(response);
      return response;
    }, undefined, (landed) => { booked = landed; });
    if (lines && at >= 0 && unsent !== undefined) lines[at] = booked ? { ...fee, usd: 0, basis: `not billed (not sent: ${unsent})` } : { ...fee, basis: `${fee.basis}; its settle failed, so the hold stands, not $0 (not sent: ${unsent})` };
    return answer;
  };

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
        ...(config.client ? { client: config.client } : {}),
        pay,
        now,
      });
      runs.set(id, run);
    }
    return run;
  };
  let readers: Readers | undefined;
  // A provider that ends the order is made by webRead for each read, never here.
  const readersOf = (): Readers => (readers ??= Object.fromEntries(config.order.fetch.filter((id) => !providerOf(id).fetch?.ends).map((id) => [id, readerOf(runOf(id), toolBreaker("fetch", id, fetchBreakers(id), keyBreakers(id)))])));

  const destinationOf = (id: ProviderId, tool: "search" | "fetch", own: (name: string) => Breaker): Destination => {
    const provider = providerOf(id);
    const keyed = (config.keys as Partial<Record<string, string>> | undefined)?.[id] !== undefined;
    const access = provider.key ? (keyed ? "keyed" : "unkeyed") : provider.keyless ? "keyless" : "none";
    const held = toolBreaker(tool, id, own(id), keyBreakers(id)).holding();
    return { id, access, ...(held ? { held } : {}) };
  };

  return {
    destinations: () => ({ search: config.order.search.map((id) => destinationOf(id, "search", runBreakers)), fetch: config.order.fetch.map((id) => destinationOf(id, "fetch", fetchBreakers)) }),
    async search(input, { n, signal, breakers: given, keyLimits = given ? "call" : "web", task, bounds, session } = {}) {
      const ownOf = given ?? runBreakers;
      const breakerOf = (name: string) => toolBreaker("search", name as ProviderId, ownOf(name), keyLimits === "web" ? keyBreakers(name) : ownOf(`${name} key`));
      const lines: Fee[] = [];
      const tries: Try[] = [];
      const asked: Record<string, unknown> = typeof input === "string" ? { query: input } : { ...input };
      const ask = searchArgs({ ...asked, n: asked.n ?? n });
      const order = config.order.search;
      const searchMs = bounds?.searchMs ?? config.bounds?.searchMs;
      // No provider is asked an empty objective.
      const found: Search = !ask.objective ? { error: "web_search needs an objective" }
        : !order.length ? { error: "web_search has no provider to ask" }
        : await feesOfCall.run(lines, () => searchInTurn(order.map((id) => ({ name: id, ask: (deadline: AbortSignal) => runOf(id).search!(ask, deadline, signal, bounds, session ? { session } : undefined) })), breakerOf, signal, searchMs, tries));
      // Sifted before it is fitted, so the fit sees only the kept results; fitSearch keeps every other field.
      const sifted = held ? await siftSearch(held, found, { task, signal, ms: config.bounds?.decideMs, pay: decisionPay(config.pay ?? unmetered, lines), policy }) : { answer: found, classifier: "off" as const };
      const answer: Search & Sift = fitSearch(sifted.answer);
      const { classifier } = sifted;
      const said = [asked.objective, asked.query].find((one): one is string => typeof one === "string") ?? "";
      // A copy: a sift this call stopped waiting for may still pay, and its fee is not on this receipt.
      const spent = [...lines];
      // An empty search's receipt keeps the words it was given.
      const receipt: Receipt = { op: "search", asked: ask.objective || said, queries: ask.queries, provider: "error" in answer ? null : answer.provider, tries, classifier, ...unjudged, out: outOf(searchText(answer)), cost: { usd: usd(spent), lines: spent }, ...unsifted(() => searchText(fitSearch(found))) };
      return { answer, receipt };
    },
    // Only the call's part, resolver, transport, signal, task, objective and session are read: the guard, its bound, the order
    // and the readers stay the Web's.
    async fetch(url, { offset, maxChars, task, objective, lookingFor, lookup, fetchImpl, signal, session } = {}) {
      const asked = typeof url === "string" ? url : "";
      // What a receipt names: the URL as the page names it, with no user name or password (askedUrl).
      const named = askedUrl(url);
      const lines: Fee[] = [];
      const tries: Try[] = [];
      // A part a call may not ask for is refused before anything is fetched.
      const problem = partProblem({ offset, maxChars });
      if (problem) {
        const refused: Page = { ok: false, url: named, status: 0, title: "", text: "", links: [], error: problem };
        const classifier = held ? (await judgePart(held, asked, refused, {})).classifier : "off";
        return { answer: refused, receipt: { op: "fetch", asked: named, provider: null, tries, classifier, ...unjudged, out: outOf(webFetchText(refused)), cost: { usd: 0, lines }, ...unsifted(() => webFetchText(refused)) } };
      }
      const cached = typeof url === "string" && pages.has(pageKey(url));
      const whole = await feesOfCall.run(lines, () =>
        webRead(url, {
          ...(lookup ? { lookup } : {}),
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(signal ? { signal } : {}),
          ...(session ? { client: { session } } : {}),
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
      const decider = held;
      const guard = config.pageGuard && decider && whole.ok ? (options: StepOptions) => guardOf(decider, asked, whole, options) : undefined;
      const decided = await decideFetch(decider, asked, whole, part, { task, objective: typeof objective === "string" && objective.trim() ? objective : lookingFor, signal, ms: config.bounds?.decideMs, pay: config.pay ?? unmetered, lines, guard });
      // What the objective found names each provider asked ahead that gave no page, as the part does.
      const answer: FetchAnswer = "found" in decided.answer ? { ...decided.answer, ...missesOf(whole) } : decided.answer;
      const { classifier, guard: verdicts } = decided;
      // Copies: a read this call stopped waiting for goes on, and its later turns and fees are not on this receipt.
      const spent = [...lines];
      const receipt: Receipt = { op: "fetch", asked: named, provider, tries: [...tries], classifier, ...(verdicts ? { wall: verdicts.wall, injection: verdicts.injection } : unjudged), out: outOf(webFetchText(answer)), cost: { usd: usd(spent), lines: spent }, ...(cached ? { cache: "hit" as const } : {}), ...unsifted(() => webFetchText(part)) };
      return { answer, receipt };
    },
  };
}
