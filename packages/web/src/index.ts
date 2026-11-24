// @parcha/agentrun-web: web search and web fetch for an agent. It imports nothing of a server, a harness, a browser or a
// vendor SDK: the public-host guard, the HTML reader, the run's cap, a native search and a product's words come in
// through WebConfig (createWeb) or as arguments, as data or injected functions.
//
// The package's whole API, named one by one: createWeb and its types, the pieces it is built from (README), and the
// bounds and words AgentRun's server reads. Anything else in src is internal and may change in any release.
export { type FetchOptions, type NativeSearch, type ProviderId, type Receipt, type SearchOptions, type SearchProvider, type Web, type WebConfig, createWeb } from "./web.js";
export { type Guard, type GuardOptions, type HtmlRead, type HtmlReader, type PublicAnswer, type PublicCheck, type PublicFetch } from "./guard.js";
export {
  type Fee,
  type ParallelSearchMode,
  type Pay,
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
  type Hit,
  type Limit,
  type Search,
  type SearchBounds,
  type Searched,
  type Try,
  ANSWER_MAX,
  breakers,
  CITE,
  fitSearch,
  QUERY_MAX,
  RESULTS_DEFAULT,
  RESULTS_MAX,
  SEARCH_MAX_CHARS,
  SNIPPET_MAX,
  searchArgs,
  searchInTurn,
  searchText,
  snippetOf,
} from "./search.js";
export { type FetchProvider, type FetchTry, type Pages, type WebFetchOptions, type WebLog, type WebPage, type WebRead, type WebUnread, FETCH_ORDER, PAGES_HELD, webFetch, webFetchText } from "./fetch.js";
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
export { fetchPage, readDirect } from "./providers/direct.js";
export { type ExaLimited, exaSearch } from "./providers/exa-keyless.js";
export { type FirecrawlFailed, type FirecrawlOptions, type KeylessFetch, firecrawlFetch, firecrawlScrape, firecrawlSearch } from "./providers/firecrawl-keyless.js";
export type { Words } from "./providers/mcp.js";
export { type Extract, PARALLEL_EXTRACT_URL, PARALLEL_SEARCH_URL, parallelExtract, parallelSearched } from "./providers/parallel.js";
export { type WrittenLink, linksOf, linksWritten, TRAILING, trimmed, wholeUrl } from "./text-urls.js";
