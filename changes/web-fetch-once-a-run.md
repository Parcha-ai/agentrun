---
packages: @parcha/agentrun-serve
kind: fix
---
`web_fetch` fetches a page once a run. The first call for a URL reads the page, through Parallel's extract or the direct fetch, and the run keeps what it read of its last 8 pages, by the URL asked for: every later part of that URL comes from it, with no request. Through Parallel, each part used to be one more billed extract, asked for the page's text up to that part's end with no ceiling. Now a page costs one extract a run, asked for its first 1,000,001 characters, and its parts never mix the two providers' text. A page is read to its first 1,000,000 characters from either provider. An `offset` at or past them is refused before anything is fetched, and the last part a read reaches of a longer page has `beyond_read`. A page's links left out past their caps are counted, `links_omitted`.
