---
packages: @parcha/agentrun-serve
kind: fix
---
`web_fetch` through Parallel never asks Parallel's extract for more than a page's first 1,000,001 characters. Parallel's extract has no offset, so each part asks for the page's text up to one character past the part, and before this nothing capped it. Each part is still one billed extract, as the tool's description and the README now say. A page is read to its first 1,000,000 characters from either provider. An `offset` at or past them is refused before anything is fetched, and the last part a read reaches of a longer page has `beyond_read`. Where Parallel is picked and gives no page for a later part, the answer is the page fetched directly from its start, not from the offset (`restarted`, with a line saying the earlier parts came from Parallel's text). A page's links left out past their caps are counted, `links_omitted`.
