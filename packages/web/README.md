# @parcha/agentrun-web

Web search and web fetch for agents. Each provider is asked in an order given as data, behind a breaker of its own. A
run keeps a page cache it reads in parts. A direct fetch goes only through a public-host guard the caller injects.
AgentRun's server answers `web_search` and `web_fetch` through it.

It imports nothing from the server, a browser or a vendor SDK. Everything from outside comes in through `WebConfig`:
the provider order, the keys, the guard, the run's cap and the words a provider's refusal is told in.

## One run's web

```js
import { createWeb } from "@parcha/agentrun-web";

const web = createWeb({
  order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: ["firecrawl-keyless", "direct"] },
  guard, // { fetch(url, options), html?(html, url, options) }: the public-host guard and its HTML reader
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

Each call returns its `answer` and a `receipt`, `{ op, asked, provider, tries, out, cost, cache? }`. `tries` lists every
provider asked, with its outcome. `cost` holds the fees of the requests sent. `classifier` is `"off"`; `wall` and
`injection` are `"unjudged"`.

The pieces `createWeb` is built from are exported too: `searchWith`, `searchInTurn` and `breakers` for search,
`webFetch` and `webFetchText` for fetch, `fetchPage` for one direct read, the providers, and the Parallel prices in
`fees`, and `linksOf`, the links a page's text holds. `@parcha/agentrun-web/text-urls` holds the link finder alone, for
code that only finds the URLs in a text (the console's timeline compiles it from source).

## Known differences from serve's composition

AgentRun's server composes these pieces itself rather than calling `createWeb`. Its `test/web-composition.test.mjs`
drives both on the same fakes, the same clock and the same steps, for every search and fetch order the server has, and
holds them to the same answers, providers reached, `tries` and breaker holds. Four differences stand by design:

- The server fits a search's answer to the model (its `fitSearch`) in the tool. `createWeb`'s answer is unfitted; the
  test compares the server's answer with `fitSearch` of `createWeb`'s.
- The server's fetch-side Firecrawl breaker reads `Date.now`. `createWeb`'s reads `now` from `WebConfig`. Under a real
  clock they are the same.
- The server keeps its breakers and its page cache per tool binding and per run's environment. `createWeb` keeps them
  per `Web`.
- The server's words for a tool plane that is unavailable, and for an order that names no provider in its faux mode,
  are the server's alone: `createWeb` has neither case.
