# @parcha/agentrun-web

Web search and web fetch for agents. Each provider is asked in an order given as data, behind a breaker of its own. A
run keeps a page cache it reads in parts. A direct fetch goes only through a public-host guard the caller injects.
AgentRun's server answers `web_search` and `web_fetch` through one `createWeb` per run.

It imports nothing from the server, a browser or a vendor SDK. Everything from outside comes in through `WebConfig`:
the provider order, the keys, the guard, the run's cap and the words a provider's refusal is told in.

## One run's web

```js
import { createWeb } from "@parcha/agentrun-web";

const web = createWeb({
  order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: ["firecrawl-keyless", "direct"] },
  guard, // { fetch(url, options), check(url, options), html?(html, url, options) }: the public-host guard
});
const { answer, receipt } = await web.search("agentrun durable workflows", { n: 5 });
const page = await web.fetch("https://example.org/", { offset: 0, maxChars: 20_000 });
```

- `order.search` holds the search providers in the order they are asked: `parallel`, `firecrawl-keyless`,
  `exa-keyless`, `native`. The next is asked when one errs or its breaker holds it. `order.fetch` holds the fetch
  providers, with `direct` for the guarded direct fetch. An order without `direct` never fetches a page itself.
- `guard` is the only way a page is fetched directly. Without one, nothing is fetched directly and no URL goes to a
  provider: the read fails closed. A guard failure shaped `{ failure: { code: "refused" } }` is a refusal: the page is
  not read, and the model is told why.
- `keys.parallel` is Parallel's key. `pay(fee, send)` is the run's cap: it sends the request when the fee fits, or
  throws a `PaidRefused`. Without it, a request is unmetered.
- `words.rateLimited` is what a keyless provider's rate limit says to the model.
- `native` is the model's own hosted search, as a function. `send` and `endpoints` replace a provider's fetch or address
  (a test's fakes). `now` is the breakers' clock. `bounds` sets a search's deadline. `log` receives what a fetch notes
  that the model is not told.
- A search's answer is fitted to `SEARCH_MAX_CHARS`: past it, its least relevant results are left out and `omitted`
  counts them. `search(query, { breakers })` reads and trips the given breakers instead of the Web's own (AgentRun's
  server gives a call node fresh ones each call). `fetch(url, { lookup, fetchImpl })` dials through the given resolver
  and transport.

Each call returns its `answer` and a `receipt`, `{ op, asked, provider, tries, classifier, wall, injection, out, cost,
cache?, unsifted? }`. `tries` lists every provider asked, with its outcome. `cost` holds the fees of the requests sent.
`classifier` is `"off"` unless a decider is given (below); `wall` and `injection` are `"unjudged"` unless the page
guard (`pageGuard`) judged the page (below).

## The classifier step

`decider` sifts each search's results and judges each fetched part before the model reads them. Without one, every
answer, model text and receipt is byte-identical to a web that has no step (`test/web-decide-off.test.mjs`).

```js
import { createWeb, deciderFrom } from "@parcha/agentrun-web";
import { JEV_PUBLISHED_PRICING, jevProvider } from "@parcha/agentrun-jev";

const decider = deciderFrom(jevProvider(), { price: JEV_PUBLISHED_PRICING });
const web = createWeb({ order, guard, pay, decider, bounds: { decideMs: 30_000 } });
const { answer, receipt } = await web.search("widgets delaware", { n: 5, task: "Where is Widgets, Inc. registered?" });
```

- `deciderFrom(provider, { price, model?, count? })` takes any `DecisionProvider` (`jevProvider`,
  `parallelProvider`, `anthropicProvider` from `@parcha/agentrun-decisions`); web declares only the `decide` method it
  calls (`DecisionAsker`), so it depends on no provider. Each call asks noul questions, one per result or passage, in
  fixed words (`siftRequest`, `judgeRequest`): every provider is asked the same thing. The need is only ever what the
  call carries: a search's `task` takes its query's place when the call gives one, else the query is the need; a
  fetch's need is its `lookingFor`, else its `task`.
- Every provider is sent the same states. A request's state is at most `STATE_BUDGET_BYTES` (90,000, within Parallel's
  96,000) and asks at most `QUESTIONS_PER_REQUEST` (100). A search over the budget has every snippet cut to the longest
  length that fits (`trimmed: { snippets, to_chars }`; the model still reads them whole). Passages over it are asked
  in several requests, one after another, ids counted across the part, and the verdicts merged in order.
- The decider only asks: it gives one score per item, `p(needed)`, or null where the provider refused the question. The
  step decides what the model reads: an item is dropped when `1 - p(needed) >= THRESHOLD` (0.8). A refused question
  keeps its item.
- `policy` (WebConfig) says how a search's results reach the model: `"drop"`, the default, as above; `"label"`, which
  keeps every result in the provider's order, each labelled `"relevance": 0.82` (its score to two places; none where
  refused); or `"rerank+label"`, which labels them too and puts the most relevant first (ties in the provider's order, a
  refused one last). The `sift` reads `"jev labelled 10 results with their relevance, how likely each holds what the
  search asks for (0 to 1)"` (`"jev ordered 10 results by relevance, ..."` under rerank+label), and adds `; nothing here
  looks relevant to "<query>"; consider rephrasing` when no result reaches `LOW_RELEVANCE` (0.3). A search is ranked before
  it is fitted, so the fit leaves out the least relevant. The decider is asked the same request under either policy;
  a fetched part is judged as drop judges it.
- `fetch(url, { lookingFor })` (the tool's `looking_for`) says what the agent is looking for in the page. The decider
  scores the chunks of the whole page (`passagesOf` again, at most `FIND_CHUNKS_MAX`, 200), asked its usual judge
  request with `lookingFor` as the task (trimmed, cut at `QUERY_MAX`). The answer holds the `FOUND_CHUNKS` (8) likeliest
  in page order, `found: [{ offset, relevance, text }]` (`relevance` as on a labelled search result, none where
  refused), in place of `text` and the part's offsets, and its `sift` reads `"jev showed the 8 of 31 chunks of the page
  most likely to hold what you are looking for (relevance 0 to 1), in page order; to read on from one, call web_fetch
  with its offset and no looking_for"`. `offset` and `maxChars` are not used. With no decider, or
  one that fails, the answer is the part asked for with `sift: "looking_for not applied (<why>); this part is in page
  order"`. The page is read once a run either way; a blank `lookingFor` is none.
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
  refused leaves the page `unjudged` (`wall.error` says why), adds nothing, and is asked again on the next fetch. Its
  request is a fee line of its own (`"jev's page guard"`). Search snippets are not screened.
- `receipt.unsifted`, in a run with a decider, is the text a web with none would have given the model for the same call
  (a fetch's part as asked, without `lookingFor`), whether the step ran, was skipped or failed: set beside the text the
  model read, it is what the step saved. A web with no decider writes none.
- Each decider request goes through `pay` before it is sent, held at the most it may cost (`holdOf` its `price`:
  `JEV_PUBLISHED_PRICING`, `PARALLEL_DECISION_PRICE`, `anthropicDecisionPrice()`), and is a line of its own in
  `receipt.cost` (`"jev's decision"`). One refused unbilled (configuration, auth, no connection) settles at $0; one the
  cap refuses is never sent, and the step does not run (`pay_refused`). The record's `cost` is the provider's own
  figure for what was spent, summed over its requests, and `requests` how many were sent. A request after the first that
  fails fails the step, at what every request sent cost.

The pieces `createWeb` is built from are exported too: `searchInTurn` and `breakers` for search,
`webFetch` and `webFetchText` for fetch, `fetchPage` for one direct read, the providers, and the Parallel prices in
`fees`, and `linksOf`, the links a page's text holds. `@parcha/agentrun-web/text-urls` holds the link finder alone, for
code that only finds the URLs in a text (the console's timeline compiles it from source).
