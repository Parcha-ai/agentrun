# Web providers: parameters, prices, and what this library exposes

Read on 2026-11-24 from each provider's current API docs and pricing pages (URLs in each section). Prices were checked
against each provider's own cost report in a live smoke the same day (06:46Z to 06:47Z UTC), where the provider gives one.
Check again before a paid run: providers change both.

The **Exposed** column has four values:
- **setting**: a typed option in `WebConfig.settings`, with a default.
- **fixed**: the library always sends one value.
- **call**: the tool call gives it (the query, `n`, the page part).
- **no**: not sent.

The library exposes what changes the agent's context (how many characters reach it, and from where) and its quality
(search depth, freshness, sources). Everything else stays at the provider's default.

## Parallel (`"parallel"`, key `PARALLEL_API_KEY`)

Docs:
- Search API: https://docs.parallel.ai/api-reference/search/search
- Extract API: https://docs.parallel.ai/api-reference/extract/extract
- Search modes: https://docs.parallel.ai/search/modes
- Pricing: https://docs.parallel.ai/resources/pricing

Both endpoints authenticate with the `x-api-key` header.

### Search, `POST /v1/search`

| Parameter | Values (provider's default) | Exposed | Library default | Price effect |
|---|---|---|---|---|
| `search_queries` | 1 or more keyword queries, 3 to 6 words each; the docs advise 2 or 3 | call: the query, as the one entry | the query | none |
| `objective` | natural-language goal | call: the query | the query | none |
| `mode` | `turbo` (~200 ms, English and Japanese only), `fast` (~700 ms), `basic` (~1 s, extended snippets), `advanced` (~3 s, the provider's default) | setting `mode` | `fast` | turbo and fast $0.001; basic and advanced $0.005 |
| `advanced_settings.max_results` | integer (10) | call: `n` (1 to 25) | 10 | $0.001 for each result past 10 |
| `max_chars_total` | total excerpt characters across all results (no default stated) | setting `maxCharsTotal` | unset | none ("Excerpt length doesn't affect the price") |
| `advanced_settings.excerpt_settings.max_chars_per_result` | **deprecated and ignored**: the live API warns "Use max_chars_total" | fixed: 3,000 | 3,000 | none |
| `advanced_settings.source_policy.include_domains` and `exclude_domains` | domains, domain/path prefixes, or extensions such as `.gov`; at most 200 together | settings `includeDomains`, `excludeDomains` | unset | none |
| `advanced_settings.source_policy.after_date` | `YYYY-MM-DD` | setting `afterDate` | unset | none |
| `advanced_settings.fetch_policy.max_age_seconds` | at least 600 (default: cached content, no live fetch) | setting `maxAgeSeconds` | unset | none listed |
| `advanced_settings.fetch_policy.timeout_seconds`, `disable_cache_fallback` | live-fetch timeout; error rather than stale cache (false) | no | — | none listed |
| `advanced_settings.fetch_policy.as_of` | page versions as of a time (contact sales) | no | — | — |
| `advanced_settings.location` | ISO country code | no | — | none |
| `session_id`, `client_model` | for linking calls; the consuming model | no | — | none |

**Excerpts are not capped by default.** The library still sends the per-result cap (`excerpt_settings`) it always has,
so that a request with no settings is the same request as before. The live API ignores that cap and warns about it.
Each result's snippet is still clipped at 3,000 characters in the library (`SNIPPET_MAX`). In the smoke, an `advanced`
search returned 2,998-character snippets. `maxCharsTotal` is the setting that caps excerpts at the source.

**The query is sent as both the objective and the only keyword query.** Parallel's modes page calls this the most
common mistake. Splitting a question into keyword queries is the agent's job (the tool's `query`), so it is not a
setting.

### Extract, `POST /v1/extract` (web_fetch)

| Parameter | Values (provider's default) | Exposed | Library default | Price effect |
|---|---|---|---|---|
| `urls` | up to 20 | call: one URL | — | $0.001 per URL |
| `advanced_settings.full_content` | boolean or `{max_chars_per_result}` (false) | fixed: `{max_chars_per_result: 1,000,001}` | the page's text, to 1,000,000 characters plus one | none |
| `advanced_settings.excerpt_settings`, `objective`, `search_queries`, `max_chars_total` | query-relevant excerpts instead of the whole page | no: web_fetch reads the whole page in parts | — | none |
| `advanced_settings.links` | up to 512 links per page (off) | no: links are read from the text | — | none |
| `advanced_settings.fetch_policy.max_age_seconds` | at least 600 | setting `maxAgeSeconds` (shared with search) | unset | none listed |

## Exa (`"exa"`, key `EXA_API_KEY`)

Docs:
- Search: https://docs.exa.ai/reference/search
- Contents: https://docs.exa.ai/reference/get-contents
- Search types: https://docs.exa.ai/reference/search-types
- Pricing: https://exa.ai/pricing

Both endpoints authenticate with the `x-api-key` header. Each answer carries `costDollars`, Exa's own estimate.

### Search, `POST /search`

| Parameter | Values (provider's default) | Exposed | Library default | Price effect |
|---|---|---|---|---|
| `query` | string | call | — | — |
| `type` | `auto` (balanced, the default); `lite` (the index only, no page fetched at query time); `deep-lite` (~4 s); `deep` (multi-step); legacy `instant`, `fast`, `deep-reasoning` | setting `type` | `auto` | lite and instant $0.004; auto and fast $0.007; deep-lite and deep $0.012; deep-reasoning $0.015 |
| `numResults` | 1 to 100 (10) | call: `n` (1 to 25) | 10 | $0.001 for each result past 10 |
| `contents.highlights` | `true` (bare: Exa sizes them to the query); `{maxCharacters}`, the total per result; or `{query}`; beta `verbosity` and `dynamic` | setting `snippet: "highlights"`; `snippetChars` sets `maxCharacters` | highlights, bare (Exa's guidance: a limit only where one is required); our snippet cut, 3,000, after | **none in a search** (Exa's own cost report) |
| `contents.text` | `{maxCharacters, verbosity, includeSections, linkStyle, includeHtmlTags}` | setting `snippet: "text"`; `snippetChars` sets `maxCharacters` (unset: 3,000) | — | **none in a search** (Exa's own cost report) |
| `contents.summary` | `{query, schema}` | no | — | $0.001 per page |
| `contents.maxAgeHours` | -1 (cache only) to 720; 0 is a live crawl (default: the cache, a live crawl only for a page Exa has none of) | setting `maxAgeHours` (shared with fetch) | unset | none listed |
| `contents.livecrawlTimeout` | ms, up to 90,000 (10,000) | no | — | — |
| `includeDomains`, `excludeDomains` | up to 1,200 each; hostname, path, or `*.` wildcard | settings | unset | none |
| `startPublishedDate`, `endPublishedDate` | ISO 8601 | no | — | none |
| `category` | `company`, `publication`, `news`, `personal site`, `financial report`, `people` | setting `category` | unset | none |
| `userLocation`, `moderation`, `additionalQueries` (deep only), `outputSchema` (synthesis, ~2 s more), `objective`, `systemPrompt`, `stream`, `compliance` | — | no | — | — |
| `contents.extras`, `contents.subpages` (deprecated) | links and images per page | no | — | — |

**What a search costs.** Exa's pricing page lists contents at "$1 / 1k pages, per content type". Exa's own cost report
bills a search's text and highlights at nothing. These were measured live on 2026-11-24:

| Search | Exa's `costDollars.total` |
|---|---|
| auto, 3 results, no contents | $0.007 |
| auto, 3 results, text | $0.007 |
| auto, 3 results, text and highlights | $0.007 |
| auto, 12 results, highlights | $0.009 |
| instant, 12 results, text | $0.006 |

`exaFeeOf` books a search at what Exa bills for it. The per-page contents price applies to `/contents`, and to a
search's summaries.

**Highlights run short of the cap.** With `maxCharacters` at 3,000 (the default before highlights went bare), Exa's
highlights came back 245 to 592 characters per result. Text from the page's start fills the cap. So `snippet: "text"` gives the agent more characters, and
`"highlights"` gives it fewer, more query-relevant ones.

### Contents, `POST /contents` (web_fetch)

| Parameter | Values (provider's default) | Exposed | Library default | Price effect |
|---|---|---|---|---|
| `urls` | 1 to 100 | call: one URL | — | $0.001 per page for each content asked |
| `text.maxCharacters` | 1 to 5,000,000 | fixed: 1,000,001 | the most web_fetch reads, plus one | none |
| `text.verbosity` | `compact` (the default), `standard`, `full` | setting `pageVerbosity` | `compact` | none |
| `text.linkStyle` | `full` or `citation` (default: links removed) | setting `pageLinks` (true sends `full`) | links kept | none |
| `text.includeSections`, `excludeSections` | header, navigation, banner, body, sidebar, footer, metadata (best effort) | no | — | none |
| `maxAgeHours` | -1 to 720 | setting `maxAgeHours` (shared with search) | unset | none listed |
| `highlights`, `summary`, `subpages`, `extras`, `livecrawlTimeout`, `snapshotAsOf` | — | no | — | highlights and summary $0.001 per page each |

How Exa answers a refusal, and how the library reads it:

| Exa's answer | Library's reading |
|---|---|
| 401 or 403 (`INVALID_API_KEY`, `TEAM_BLOCKED`, `FEATURE_DISABLED`) | the key is refused for the run, for both tools |
| 402 (out of credits) | a quota: Exa is off for the run |
| 429 | a rate limit for its Retry-After |
| per-URL `statuses[].error.tag` | a failed turn naming the tag |

## Firecrawl (`"firecrawl"`, key `FIRECRAWL_API_KEY`)

Docs:
- Search: https://docs.firecrawl.dev/api-reference/endpoint/search
- Scrape: https://docs.firecrawl.dev/api-reference/endpoint/scrape
- Credit usage: https://docs.firecrawl.dev/api-reference/endpoint/credit-usage
- Pricing: https://www.firecrawl.dev/pricing
- Billing (the credit rule): https://docs.firecrawl.dev/billing

Both endpoints authenticate with `Authorization: Bearer`.

Prices are in credits. The key is on the Standard plan: `planCredits` was 100,000 from `/v2/team/credit-usage` on
2026-11-24, at $99 a month, so **$0.00099 a credit**. Credits past the plan cost $5 per 2,000 ($0.0025).

### Search, `POST /v2/search`

| Parameter | Values (provider's default) | Exposed | Library default | Price effect |
|---|---|---|---|---|
| `query` | up to 500 characters | call | — | — |
| `limit` | 1 to 100 (10) | call: `n` (1 to 25) | 10 | 2 credits per 10 results ($0.00198) |
| `highlights` | query-relevant highlights as each result's description (true) | setting `highlights` | unset (Firecrawl's true) | none |
| `tbs` | `qdr:h`, `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y`, `cdr:1,cd_min:…,cd_max:…`, `sbd:1` | setting `tbs` | unset | none |
| `includeDomains`, `excludeDomains` | hostnames; one or the other, not both | settings | unset | none |
| `country` | ISO code (US) | setting `country` | unset | none |
| `location`, `sources` (web, news, images), `categories` (developer, gov, research, pdf), `safe`, `timeout`, `ignoreInvalidURLs`, `enterprise`, `threatProtection`, `toolDetail`, `domainTools` | — | no | — | threatProtection +2 credits per URL; `zdr` and `anon` cost more |
| `scrapeOptions` | scrape each result (formats, onlyMainContent, maxAge, proxy, parsers, …) | no: each result's snippet is Firecrawl's description, its query-relevant highlight, as Exa's highlights and Parallel's excerpts are; `web_fetch` reads a page whole | — | each result that comes back scraped: 1 credit for a page, 1 a PDF page parsed (+4 for JSON); a result with no document 0 |

The smoke's description snippets were 142 to 839 characters, with highlights on. `creditsUsed` was 2 for 3 results.

A search's hold is 2 credits per 10 of its limit, rounded up: 2 credits for a limit of 4 or 10. It is charged the
`creditsUsed` Firecrawl's answer reports, never above the hold. Measured on 2026-11-28: with each result scraped, a
limit-4 search whose results were PDFs reported up to 162 credits, and one Seal-0 search 2,038 (a 1,024-page PDF among
its results); the same searches without a scrape reported 2.

### Scrape, `POST /v2/scrape` (web_fetch)

| Parameter | Values (provider's default) | Exposed | Library default | Price effect |
|---|---|---|---|---|
| `url` | — | call | — | 1 credit ($0.00099) for a page; a PDF 1 credit per page parsed |
| `formats` | markdown, summary, html, rawHtml, links, images, screenshot, json, changeTracking, branding, … (markdown) | fixed: markdown | markdown | json +4 credits |
| `onlyMainContent` | true or false (true) | setting `onlyMainContent` | true | none |
| `maxAge` | ms (172,800,000, two days); 0 is a fresh scrape | setting `maxAgeMs` | unset | none |
| `parsers` | pdf (with `maxPages`, 1 to 10,000), image (pdf, all pages) | setting `pdfMaxPages`: `[{type: "pdf", maxPages}]` | unset: a PDF read whole | 1 credit per PDF page parsed; a cap bounds the fee and the hold |
| `proxy` | basic, enhanced, auto (auto) | fixed: basic | basic | basic is the one priced here; a body asking another is refused before it is sent |
| `includeTags`, `excludeTags`, `waitFor`, `mobile`, `actions`, `location`, `headers`, `blockAds` (true), `removeBase64Images` (true), `timeout` (60 s), `storeInCache`, `lockdown`, `checkPromptInjection`, `redactPII`, `zeroDataRetention` | — | no | — | PDF: 1 credit per PDF page; checkPromptInjection +4; lockdown 5 on a hit, 1 on a miss |

How Firecrawl answers a refusal, and how the library reads it:

| Firecrawl's answer | Library's reading |
|---|---|
| 401 | the key is refused for the run, for both tools |
| 402 (insufficient credits) | a quota: Firecrawl is off for the run |
| 429 | a rate limit for its Retry-After |
| 403 (`SCRAPE_PROMPT_INJECTION_DETECTED`, `THIRD_PARTY_DATA_TERMS_REQUIRED`) | one page's failure only; Firecrawl stays in |
| a non-2xx `metadata.statusCode` | no page |

A PDF costs a credit a page, and the library cannot know a URL's page count before it asks, so a scrape is held at
the most Firecrawl parses of one PDF: 10,000 credits, **$9.90**, or `pdfMaxPages` credits when that setting caps it (4
more for JSON). It is charged the `data.metadata.creditsUsed` Firecrawl's answer reports: 1 credit for an HTML page, a
PDF's parsed pages for a PDF. Reported credits above the hold are charged at the hold, and the receipt line says
Firecrawl reported more. An answer with no whole, non-negative `creditsUsed` (missing, fractional, negative, not a
number, or not JSON) is charged the hold, never $0. The receipt line names the reported credits and the hold.

**A run whose cap has less than $9.90 left cannot `web_fetch` through keyed Firecrawl** unless `pdfMaxPages` lowers
the hold: the cap refuses the hold before the request is sent. Parallel, the default, is unaffected. With
`pdfMaxPages` set, a PDF longer than the cap reaches the agent starting `[PDF: pages 1-100 of 128 were read; pages
101-128 are not in this text]`.

## Best and cheapest configurations

These are the configurations used in the benchmark hand-off (B0 and C1). Where an option does not change the price, it
is the same in both.

| Provider | Tool | Best | Cheapest | Price, best vs cheapest |
|---|---|---|---|---|
| Parallel | search | `{mode: "advanced"}` | `{mode: "turbo"}` (English and Japanese only) or `"fast"` | $0.005 vs $0.001 |
| Parallel | fetch | no settings | no settings | $0.001 |
| Exa | search | `{type: "deep", snippet: "highlights"}` | `{type: "lite", snippet: "highlights"}` | $0.012 vs $0.004 |
| Exa | fetch | no settings (compact, links kept) | no settings | $0.001 |
| Firecrawl | search | no settings (highlights on) | no settings | $0.00198 (2 credits per 10 results) |
| Firecrawl | fetch | no settings (`onlyMainContent: true`) | `pdfMaxPages` low | the credits reported: 1 ($0.00099) for a page, a PDF its pages; held at 10,000 ($9.90), or `pdfMaxPages` |
