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
cache? }`. `tries` lists every provider asked, with its outcome. `cost` holds the fees of the requests sent.
`classifier` is `"off"` unless a decider is given (below); `wall` and `injection` are `"unjudged"`.

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
  fixed words (`siftRequest`, `judgeRequest`): every provider is asked the same thing.
- Every provider is sent the same states. A request's state is at most `STATE_BUDGET_BYTES` (90,000, within Parallel's
  96,000) and asks at most `QUESTIONS_PER_REQUEST` (100). A search over the budget has every snippet cut to the longest
  length that fits (`trimmed: { snippets, to_chars }`; the model still reads them whole). Passages over it are asked
  in several requests, one after another, ids counted across the part, and the verdicts merged in order.
- The decider only asks: it gives one score per item, `p(needed)`, or null where the provider refused the question. The
  step decides what the model reads: an item is dropped when `1 - p(needed) >= THRESHOLD` (0.8). A refused question
  keeps its item.
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
