# @parcha/agentrun-web

Web search and web fetch for agents. Each provider is asked in an order given as data, behind a breaker of its own. A
run keeps a page cache it reads in parts. A direct fetch goes only through a public-host guard the caller injects.
AgentRun's server answers `web_search` and `web_fetch` through one `createWeb` per run.

It imports nothing from the server, a browser or a vendor SDK. Everything from outside comes in through `WebConfig`:
the provider order, the keys, the guard, the run's cap and the words a provider's refusal is told in.

## One run's web

```js
import { createWeb } from "@parcha/agentrun-web";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";

const web = createWeb({
  order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: ["firecrawl-keyless", "direct"] },
  // The public-host guard: pi-browser's, the one AgentRun's server gives it.
  guard: { fetch: publicFetch, check: publicCheck, html: readPage },
});
const { answer, receipt } = await web.search({
  objective: "How AgentRun keeps a workflow running across restarts, from its own docs",
  queries: ["agentrun durable workflows", "agentrun workflow resume"],
  n: 5,
});
const page = await web.fetch("https://example.org/", { offset: 0, maxChars: 20_000 });
```

- `order.search` holds the search providers in the order they are asked: `parallel`, `firecrawl-keyless`,
  `exa-keyless`, `native`. The next is asked when one errs or its breaker holds it. `order.fetch` holds the fetch
  providers, with `direct` for the guarded direct fetch. An order without `direct` never fetches a page itself.
- `guard` is the only way a page is fetched directly. Without one, nothing is fetched directly and no URL goes to a
  provider: the read fails closed. A guard failure shaped `{ failure: { code: "refused" } }` is a refusal: the page is
  not read, and the model is told why. `guard.check` decides which URLs go to Firecrawl and Parallel, so it must refuse
  every URL `guard.fetch` would refuse: a check that passes everything sends private and internal URLs to a provider.
  A guard is the Web's alone; one passed with a `fetch` call is ignored.
- A page's `links` come with its first part. A page a provider read as markdown (Parallel, Firecrawl, Exa) writes each of
  its links in its text, so that part lists only the links its own text does not write, within the caps, and
  `links_omitted` counts those of them the caps left out. A page fetched directly lists its link targets as before.
- `keys.parallel` is Parallel's key. `pay(fee, send)` is the run's cap: it sends the request when the fee fits, or
  throws a `PaidRefused`. Without it, a request is unmetered.
- `words.rateLimited` is what a keyless provider's rate limit says to the model. A keyed provider's limit (Parallel's,
  keyed Exa's or Firecrawl's 402 or 429, a hosted search's) says, on the call that met it as on every call it holds,
  what its breaker says: that search is busy for the seconds left of its wait, or unavailable for the rest of the run;
  the receipt's turn keeps the provider's words.
- `native` is the model's own hosted search, as a function. `send` and `endpoints` replace a provider's fetch or
  address (a test's fakes). `now` is the breakers' clock. `bounds` sets the searches' deadlines. `log` receives what a
  fetch notes that the model is not told.
- A search asks `{ objective, queries?, n? }` (`searchArgs`): the objective says in a sentence what the search is for
  (trimmed, at most `OBJECTIVE_MAX`, 1,000 characters), the queries are up to `QUERIES_MAX` (5) short keyword searches
  (each trimmed and cut at `QUERY_MAX`, 200, blanks and repeats dropped), and with none the objective's first 200
  characters are the one query. A string, or `{ query }` alone (deprecated), is the objective and the one query; a model's tool call, checked against `WEB_SEARCH_PARAMETERS`, must give the objective. An
  empty objective is `{ error: "web_search needs an objective" }`, and no provider is asked. Each provider is sent what
  it takes: Parallel the objective and the queries (`objective`, `search_queries`, mode `fast`, plus `client_model` and
  `session_id` when `client` names them); Exa, keyed and keyless, the objective as its query; Firecrawl, keyed and
  keyless, up to 3 of the queries at once, each asked for `ceil(n / k)` results scraped as markdown (main content only),
  the results merged by URL in first-seen order and cut at `n`, each snippet its page's markdown; keyless Firecrawl
  sends the objective too, which its tool requires; `native` the first query. The answer is `{ provider, objective,
  queries, results }`.
- `client` (WebConfig) is `{ model?, session? }`: the model the run calls, as a bare id (`claude-opus-4-7`), and an id of
  the run. `search(ask, { session })` gives one call its own session in place of the Web's. Each is sent to a provider
  that takes it only when given; nothing is made up in their place.
- `WEB_SEARCH_DESCRIPTION`, `WEB_SEARCH_PARAMETERS`, `WEB_FETCH_DESCRIPTION` and `WEB_FETCH_PARAMETERS` are what a model
  reads of the two tools: each description, and its parameters' JSON Schema. They name no provider, so every provider is
  asked through the same words. AgentRun's server builds its `web_search` and `web_fetch` from them.
- A search's answer is fitted to `SEARCH_MAX_CHARS`: past it, its least relevant results are left out and `omitted`
  counts them. `search(ask, { breakers })` reads and trips the given breakers instead of the Web's own (AgentRun's
  server gives a call node fresh ones each call), and `search(ask, { bounds })` holds that call to its own deadlines.
  `fetch(url, { lookup, fetchImpl })` dials through the given resolver and transport.

Each call returns its `answer` and a `receipt`, `{ op, asked, queries?, provider, tries, classifier, wall, injection, out, cost,
cache?, unsifted? }`. `asked` is a search's objective (the words given, when it has none) or a fetch's URL, and
`queries` a search's queries. `tries` lists the providers asked before the call returned, in the order asked, with each outcome,
and a provider its breaker holds as `held`. A fetch also lists Parallel where it was passed over (no key, refused
earlier in the run, or a URL it may not be sent), with why; a part from the run's pages lists none. `cost` holds the fees
of the requests sent before the call returned. A fetch stopped at its signal returns at once, but its read is the run's
and goes on: a provider asked after the stop is in neither; one whose request was already sent has its fee in `cost` but
no turn in `tries`. `classifier` is `"off"` unless a decider is given (below); `wall` and `injection` are `"unjudged"`
unless the page guard (`pageGuard`) judged the page (below).

## The classifier step

`decider` sifts each search's results and judges each fetched part before the model reads them. Without one, every
answer, model text and receipt is byte-identical to a web that has no step (`test/web-decide-off.test.mjs`).

```js
import { createWeb, deciderFrom } from "@parcha/agentrun-web";
import { JEV_PUBLISHED_PRICING, jevProvider } from "@parcha/agentrun-jev";

const decider = deciderFrom(jevProvider(), { price: JEV_PUBLISHED_PRICING });
const web = createWeb({ order, guard, pay, decider, bounds: { decideMs: 30_000 } });
const { answer, receipt } = await web.search({ objective: "Where Widgets, Inc. is registered", queries: ["widgets delaware"] }, { n: 5, task: "Where is Widgets, Inc. registered?" });
```

- `deciderFrom(provider, { price, model?, count? })` takes any `DecisionProvider` (`jevProvider`,
  `parallelProvider`, `anthropicProvider` from `@parcha/agentrun-decisions`); web declares only the `decide` method it
  calls (`DecisionAsker`), so it depends on no provider. Each call asks noul questions, one per result or passage, in
  fixed words (`siftRequest`, `judgeRequest`): every provider is asked the same thing. The need is only ever what the
  call carries: a search's `task` takes its objective's place when the call gives one, else the objective is the need; a
  fetch's need is its `objective`, else its `task`.
- A Jev decider on TypeSafe's route (`jevProvider` reading `TYPESAFE_API_KEY`) sends `JEV_MODEL` (`jev-1.14.0`, the
  version the thresholds were read on) unless `model` names another; on OpenRouter's route, and for any other provider,
  no model is sent and the provider's own default holds.
- Every provider is sent the same states. A request's state is at most `STATE_BUDGET_BYTES` (90,000, within Parallel's
  96,000) and asks at most `QUESTIONS_PER_REQUEST` (100), a judge request at most `PASSAGES_MAX` (50) passages. A
  search over the budget has every snippet cut to the longest length that fits (`trimmed: { snippets, to_chars }`; the
  model still reads them whole). Passages over either are asked in several requests, `REQUESTS_AT_ONCE` (4) at a time,
  ids counted across the page, and the verdicts merged in order; one failed request fails the step.
- The decider only asks: it gives one score per item, `p(needed)`, or null where the provider refused the question. The
  step decides what the model reads: an item is dropped when `1 - p(needed) >= THRESHOLD` (0.8). A refused question
  keeps its item.
- `policy` (WebConfig) says how a search's results reach the model: `"drop"`, the default, as above; `"label"`, which
  keeps every result in the provider's order, each labelled `"relevance": 0.82` (its score to two places; none where
  refused); or `"rerank+label"`, which labels them too and puts the most relevant first (ties in the provider's order, a
  refused one last). The `sift` reads `"jev labelled 10 results with their relevance, how likely each holds what the
  search asks for (0 to 1)"` (`"jev ordered 10 results by relevance, ..."` under rerank+label), and adds `; nothing here
  looks relevant to "<objective>"; consider rephrasing` when no result reaches `LOW_RELEVANCE` (0.3). A search is ranked before
  it is fitted, so the fit leaves out the least relevant. The decider is asked the same request under either policy;
  a fetched part is judged as drop judges it.
- `fetch(url, { objective })` (the tool's `objective`; `lookingFor`, the tool's `looking_for`, is its alias, and
  `objective` wins when both are given) says what the agent is looking for in the page. The decider scores the chunks of
  the whole page (`passagesOf` again, at most `FIND_CHUNKS_MAX`, 200), asked its usual judge request with the objective
  as the task (trimmed, cut at `QUERY_MAX`). The answer holds the `FOUND_CHUNKS` (8) likeliest
  in page order, `found: [{ offset, relevance, text }]` (`relevance` as on a labelled search result, none where
  refused), in place of `text` and the part's offsets, and its `sift` reads `"jev showed the 8 of 31 chunks of the page
  most likely to hold what your objective asks for (relevance 0 to 1), in page order; to read on from one, call
  web_fetch with its offset and no objective"`. `offset` and `maxChars` are not used: where a call gives an offset past 0
  or a `maxChars`, the `sift` line ends `"; offset ignored: found chunks come from the whole page, each with its
  offset"` (`max_chars`, or `offset and max_chars`, as given). With no decider the answer is the part asked for, its
  `sift` `"objective not applied (no classifier in this run); this part is in page order"`; with one that fails, the
  part asked for with `sift: "objective not applied (<why>); this part is in page order"`. The page is read once a run either way; a blank objective is none.
- A fetched part is judged in passages (`passagesOf`: whole paragraphs packed to about 1,000 characters, at most 50).
  The kept ones stay in order, `LEFT_OUT` stands for each run left out, and the part's `chars`, `offset` and
  `next_offset` are unchanged. A fetch with no `task` is not judged.
- The answer's `sift` tells the model what was done: `"jev kept 3 of 5 results"`, or `"not run (timeout); these results
  are unsifted"`. A decider that fails, refuses every question, answers out of shape or passes `bounds.decideMs`
  (`DECIDE_MS`, 30 s) never drops anything silently: the items pass unsifted and the record says why.
- `receipt.classifier` is the decision's record: `{ provider, op, ran, items: { in, kept }, dropped: [{ id, score,
  reason, at? }], model, temperature_sent, temperature_applied, tokens: { in, out, basis }, latency_ms, cost: { usd,
  basis }, requests, questions_sha256: [one per request], trimmed?, error?, skipped?, scored: [{ id, score, at? }] }`.
  `scored` holds every item asked about, in order, kept or dropped: a result by its URL, a passage by its id and its
  place in the page. It is empty when the step did not run. `tokens` are the provider's
  when it reports them, else counted on the request by `count`, else null. `temperature_sent` and `temperature_applied` (true, false or "unknown") are what
  the provider says its request carried; one that says nothing sent none.
- The page guard (`pageGuard: true`, off unless set; it asks the run's decider, so it throws without one): each page a
  fetch reads is asked about once a run (`pageGuardRequest`: its
  URL, status and first `GUARD_CHARS`, 16,000 characters; the same two questions, in pi-browser's page classifier's
  words, for every page). `wall` is a choice between `content` and the `WALLS` (login wall, paywall, CAPTCHA, error
  page, ...); `injection` asks whether the text holds instructions addressed to an AI reader. The receipt's `wall` is
  `{ verdict, scores }` (`content`, or the likeliest wall, at `WALL_THRESHOLD` 0.6; between, `unjudged`) and its
  `injection` `{ verdict: "injection" | "none", score }` (at `INJECTION_THRESHOLD` 0.75). A judged wall or injection
  adds one plain `warning` to the answer, such as `"this looks like a login wall, not the page's own content (0.9); if
  you need the page, try another source"`, and the page's text is kept: a hint, never a gate. A guard that fails or is
  refused leaves the page `unjudged` (`wall.error` says why), adds nothing, and is asked again on the next fetch. It is
  asked beside the step, and its request is a fee line of its own (`"jev's page guard"`), after the step's. Search snippets are not screened.
- `receipt.unsifted`, in a run with a decider, is the text a web with none would have given the model for the same call
  (a fetch's part as asked, without its objective), whether the step ran, was skipped or failed: set beside the text the
  model read, it is what the step saved. A web with no decider writes none.
- Each decider request goes through `pay` before it is sent, held at the most it may cost (`holdOf` its `price`:
  `JEV_PUBLISHED_PRICING`, `PARALLEL_DECISION_PRICE`, `anthropicDecisionPrice()`), and is a line of its own in
  `receipt.cost` (`"jev's decision"`). One answered is charged, and its line says, the cost its provider gave
  (reported, or estimated where it reported none; the line's basis says which), never above its hold, and the hold
  where it gave none; `pay` is told that charge (`charged`), so a cap books what the receipt says. One refused
  unbilled (configuration, auth, no connection) settles at $0; one the cap refuses is never sent, and the step does not run (`pay_refused`). The record's `cost` is the provider's own
  figure for what was spent, summed over its requests, and `requests` how many were sent. A request after the first that
  fails fails the step, at what every request sent cost.

The pieces `createWeb` is built from are exported too: `searchInTurn` and `breakers` for search, `webFetch` and
`webFetchText` for fetch, `fetchPage` for one direct read, and `linksOf`, the links a page's text holds. So are the
providers (`exaSearch`, `firecrawlFetch`, `firecrawlScrape`, `firecrawlSearch`, `parallelExtract`, `parallelSearched`)
and Parallel's prices and fees (`PARALLEL_EXTRACT_USD`, `PARALLEL_SEARCH_USD`, `PARALLEL_SEARCH_INCLUDED`,
`PARALLEL_SEARCH_MODE_USD`, `PARALLEL_SEARCH_RESULT_USD`, `parallelExtractFee`, `parallelSearchFee`, `parallelFeeOf`,
`PaidRefused` and `unmetered`). The package's entry names each export; nothing else in it is API.
`@parcha/agentrun-web/text-urls` holds the link finder alone, for code that only finds the URLs in a text (the
console's timeline compiles it from source).

The rest of the entry is for servers: the bounds and words AgentRun's server builds its two tools from, and the helpers
that apply them. A caller of `createWeb` needs none of them. They are API like everything else the entry names, so a
change to one is a change to the package's API.

- search: `searchArgs`, `searchText`, `fitSearch`, `snippetOf`, `CITE`, `ANSWER_MAX`, `OBJECTIVE_MAX`, `QUERIES_MAX`, `QUERY_MAX`, `RESULTS_DEFAULT`,
  `RESULTS_MAX`, `SEARCH_MAX_CHARS` and `SNIPPET_MAX`;
- fetch: `clip`, `partEnd`, `partProblem`, `readDirect`, `FETCH_ORDER`, `PAGES_HELD`, `HTML_READ_CHARS`, `LINKS_CAP`,
  `LINKS_CHARS`, `MAX_CHARS_MIN`, `PAGE_CHARS`, `PAGE_MAX_BYTES`, `PAGE_READ_MAX_CHARS`, `TEXT_CAP`, `TITLE_CAP` and
  `URL_MAX`;
- providers: `PARALLEL_EXTRACT_URL` and `PARALLEL_SEARCH_URL`;
- links: `linksWritten`, `TRAILING`, `trimmed` and `wholeUrl`.

The entry also names the provider contract and its registry (`WebProvider`, `defineProvider`, `readerOf`,
`holdingWords`, `PROVIDERS`, `providerOf`, `providerName`, `isProviderId`, `serves`, `settingsProblemsOf`,
`AHEAD`, `SAID`), the readers and breakers a server builds (`parallelReads`, `searchBreaker`),
each keyed provider's settings and defaults (`EXA_DEFAULTS`, `FIRECRAWL_DEFAULTS`, `PARALLEL_DEFAULTS`), Exa's and
Firecrawl's prices and fees (`exaFeeOf`, `firecrawlFeeOf`), a run's destinations (`destinationsLine`,
`destinationsWords`, `Hold`), and the classifier step's names above.
