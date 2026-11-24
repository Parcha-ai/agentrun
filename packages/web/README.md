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
const { answer, receipt } = await web.search("agentrun durable workflows", { n: 5 });
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
- `keys.parallel` is Parallel's key. `pay(fee, send)` is the run's cap: it sends the request when the fee fits, or
  throws a `PaidRefused`. Without it, a request is unmetered.
- `words.rateLimited` is what a keyless provider's rate limit says to the model.
- `native` is the model's own hosted search, as a function. `send` and `endpoints` replace a provider's fetch or address
  (a test's fakes). `now` is the breakers' clock. `bounds` sets the searches' deadlines. `log` receives what a fetch notes
  that the model is not told.
- A search's answer is fitted to `SEARCH_MAX_CHARS`: past it, its least relevant results are left out and `omitted`
  counts them. `search(query, { breakers })` reads and trips the given breakers instead of the Web's own (AgentRun's
  server gives a call node fresh ones each call), and `search(query, { bounds })` holds that call to its own deadlines.
  `fetch(url, { lookup, fetchImpl })` dials through the given resolver
  and transport.

Each call returns its `answer` and a `receipt`, `{ op, asked, provider, tries, out, cost, cache? }`. `tries` lists every
provider asked, with its outcome. `cost` holds the fees of the requests sent. `classifier` is `"off"`; `wall` and
`injection` are `"unjudged"`.

The pieces `createWeb` is built from are exported too: `searchInTurn` and `breakers` for search,
`webFetch` and `webFetchText` for fetch, `fetchPage` for one direct read, the providers, and the Parallel prices in
`fees`, and `linksOf`, the links a page's text holds. The package's entry names each export; nothing else in it is
API. `@parcha/agentrun-web/text-urls` holds the link finder alone, for code that only finds the URLs in a text (the
console's timeline compiles it from source).
