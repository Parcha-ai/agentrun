---
packages: @parcha/agentrun-web, @parcha/agentrun-serve
kind: refactor
---
One provider contract and one registry. Each provider is one `WebProvider` object in its own file (`defineProvider`: its id, label, key variable, the tools it serves, what its fetch does on a miss, its settings check, and `make`, the provider for one Web), registered once in `providers/registry.ts` (`PROVIDERS`). `createWeb` makes each provider an order names once per Web and asks it through one loop per tool: `searchInTurn` for web_search, and one read loop in `fetch.ts` for web_fetch, where each turn is recorded on the receipt as it is taken. `ProviderId`, `SearchProvider`, `FetchProvider`, `KeyedProvider`, a search's `provider`, a page's `via` and `ProviderSettings` are read from the registry, and `keys`, `endpoints`, `send` and `settings` are keyed by its ids. Every fetch provider sits behind the one breaker (`readerOf` on `searchBreaker`); keyless Firecrawl's and the keyed providers' own fetch breakers (`firecrawlFetch`'s, `keyedFetch`) are gone. web_search's breakers and web_fetch's stay separate per tool, as before; a refused key is refused for both tools, which share the provider's one client. `webFetch` and `webRead` take `readers` by provider id in place of `parallel`, `firecrawl` and `keyed`; `parallelReads` makes Parallel's. serve reads the registry for each resolution's chain, the fakes it names under --faux, the keys it reads for a run and the search tool's description.

Deliberate changes (the first two and the last in receipts and errors alone):
- An empty query is answered "web_search needs a query" before any provider is asked, for every order. Parallel used to answer it itself, leaving a failed turn on the receipt.
- web_fetch's turns are recorded in the order the providers were asked. A keyless Firecrawl read that gave no page is a turn on the receipt even where no direct fetch follows, with the limit it met.
- "not tried: this run holds no Parallel key" is said where Parallel's turn is reached. It used to be added to every page of an order naming Parallel, so a page a provider ahead of Parallel read said Parallel gave none and the page was "fetched directly". No serve order puts a provider ahead of Parallel.
- An order naming an id no provider has, or a provider for a tool it does not serve, throws in `createWeb`. An unknown search provider used to be asked as keyless Exa.

The breakers' scope is the base's: `test/breaker-scope.test.mjs`, written against the base, pins it for keyed Exa, Parallel and keyless Firecrawl (a refused key holds both tools; a quota or rate limit holds only the tool that met it).

A reason Parallel gave no page is said only on a page the guarded direct fetch answered, or on the answer that none read it. With an order such as `[parallel, exa, direct]`, a page Exa read after Parallel failed used to carry `parallel` and a line telling the model it was fetched directly; it now carries neither, and Parallel's turn stays on the receipt.

A logged provider's failed fetch turn with no error words now leaves `error` off the receipt's turn instead of writing an empty one. A call stopped mid-read keeps on its receipt the turns taken before the stop.
