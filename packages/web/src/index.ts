// @parcha/agentrun-web: web search and web fetch for an agent. It imports nothing of a server, a harness, a browser or a
// vendor SDK: the public-host guard, the HTML reader, the run's cap, a native search and a product's words come in
// through WebConfig (createWeb) or as arguments, as data or injected functions.
//
// The package's whole API, named one by one: createWeb and its types, the provider contract and registry, the classifier
// step, the pieces it is built from (README), and the bounds and words AgentRun's server reads. Anything else in src is
// internal and may change in any release.
export {
  type Destination,
  type Destinations,
  type FetchOptions,
  type Hold,
  type Receipt,
  type SearchInput,
  type SearchOptions,
  type Web,
  type WebConfig,
  createWeb,
  destinationsLine,
  destinationsWords,
} from "./web.js";
export { type Guard, type GuardOptions, type HtmlRead, type HtmlReader, type PublicAnswer, type PublicCheck, type PublicFetch } from "./guard.js";
export {
  type FetchShape,
  type NativeSearch,
  type ProviderParts,
  type ProviderRun,
  type ReadFailed,
  type Reader,
  type SearchAsk,
  type SettingsSpec,
  type WebClient,
  type WebProvider,
  defineProvider,
  HELD_CODE,
  holdingWords,
  readerOf,
} from "./provider.js";
export {
  type AheadProvider,
  type FetchProvider,
  type KeyedProvider,
  type ProviderId,
  type ProviderSettings,
  type SaidProvider,
  type SearchProvider,
  AHEAD,
  isProviderId,
  PROVIDERS,
  providerName,
  providerOf,
  SAID,
  serves,
  settingsProblemsOf,
} from "./providers/registry.js";
export {
  type ExaSearchType,
  type Fee,
  type ParallelSearchMode,
  type Pay,
  EXA_CONTENT_USD,
  EXA_SEARCH_INCLUDED,
  EXA_SEARCH_RESULT_USD,
  EXA_SEARCH_TYPE_USD,
  EXA_SUMMARY_USD,
  exaFeeOf,
  FIRECRAWL_CREDIT_USD,
  FIRECRAWL_JSON_CREDITS,
  FIRECRAWL_SCRAPE_CREDITS,
  FIRECRAWL_SEARCH_CREDITS,
  firecrawlFeeOf,
  PARALLEL_EXTRACT_USD,
  PARALLEL_SEARCH_INCLUDED,
  PARALLEL_SEARCH_MODE_USD,
  PARALLEL_SEARCH_RESULT_USD,
  PARALLEL_SEARCH_USD,
  PaidRefused,
  parallelExtractFee,
  parallelFeeOf,
  parallelSearchFee,
  unmetered,
} from "./fees.js";
export {
  type Backend,
  type Breaker,
  type Failure,
  type FailureClass,
  type Hit,
  type Holding,
  type Limit,
  type Search,
  type SearchBounds,
  type Searched,
  type Try,
  ANSWER_MAX,
  breakers,
  CITE,
  fitSearch,
  OBJECTIVE_MAX,
  QUERIES_MAX,
  QUERY_MAX,
  RESULTS_DEFAULT,
  RESULTS_MAX,
  SEARCH_MAX_CHARS,
  SEARCH_UNAVAILABLE,
  SNIPPET_MAX,
  searchArgs,
  searchBreaker,
  searchInTurn,
  searchText,
  snippetOf,
} from "./search.js";
export {
  type FetchTry,
  type Pages,
  type Readers,
  type Via,
  type WebFetchOptions,
  type WebLog,
  type WebPage,
  type WebRead,
  type WebUnread,
  FETCH_ORDER,
  PAGES_HELD,
  webFetch,
  webFetchText,
} from "./fetch.js";
export {
  type Page,
  type Part,
  type Read,
  type Unread,
  clip,
  HTML_READ_CHARS,
  LINKS_CAP,
  LINKS_CHARS,
  MAX_CHARS_MIN,
  PAGE_CHARS,
  PAGE_MAX_BYTES,
  PAGE_READ_MAX_CHARS,
  partEnd,
  partProblem,
  TEXT_CAP,
  TITLE_CAP,
  URL_MAX,
} from "./page.js";
export { WEB_FETCH_DESCRIPTION, WEB_FETCH_PARAMETERS, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_PARAMETERS } from "./tool-specs.js";
export { fetchPage, readDirect } from "./providers/direct.js";
export { type ExaSettings, EXA_DEFAULTS } from "./providers/exa.js";
export { type ExaLimited, exaSearch } from "./providers/exa-keyless.js";
export { type FirecrawlSettings, FIRECRAWL_DEFAULTS } from "./providers/firecrawl.js";
export { type FirecrawlFailed, type FirecrawlOptions, firecrawlFetch, firecrawlScrape, firecrawlSearch } from "./providers/firecrawl-keyless.js";
export type { Words } from "./providers/mcp.js";
export {
  type Extract,
  type ParallelSettings,
  PARALLEL_DEFAULTS,
  PARALLEL_EXTRACT_URL,
  PARALLEL_SEARCH_URL,
  parallelExtract,
  parallelReads,
  parallelSearched,
} from "./providers/parallel.js";
export { type WrittenLink, linksOf, linksWritten, TRAILING, trimmed, wholeUrl } from "./text-urls.js";
export {
  type ChoiceQuestion,
  type DeciderOptions,
  type DecisionAsk,
  type DecisionAsker,
  type DecisionPrice,
  type NoulQuestion,
  type Wall,
  type WebDecider,
  deciderFrom,
  GUARD_CHARS,
  holdOf,
  judgeRequest,
  pageGuardRequest,
  QUESTIONS_PER_REQUEST,
  REQUESTS_AT_ONCE,
  siftRequest,
  STATE_BUDGET_BYTES,
  WALLS,
} from "./decide/decider.js";
export { type FoundChunk, type FoundPage, FIND_CHUNKS_MAX, FOUND_CHUNKS, judgePart, LEFT_OUT } from "./decide/fetch.js";
export { type InjectionVerdict, type WallVerdict, INJECTION_THRESHOLD, WALL_THRESHOLD } from "./decide/page-guard.js";
export { PASSAGES_MAX, passagesOf } from "./decide/passages.js";
export { DECIDE_MS, decisionPay, type DecisionRecord, type Scored, type Sift, type StepOptions, THRESHOLD } from "./decide/record.js";
export { type DecidePolicy, LOW_RELEVANCE, siftSearch } from "./decide/search.js";
