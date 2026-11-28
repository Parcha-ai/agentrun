---
packages: @parcha/agentrun-web
kind: fix
---
Keyed Firecrawl is charged the credits Firecrawl reports, held at the most a call can cost. Before this, a search was held at 2 credits per 10 results plus 1 a scraped result, and a scrape at 1. But Firecrawl bills each PDF page it parses: on 17 measured calls it billed 6.47 times what was recorded, almost all of it in PDF pages.
A keyed search no longer asks Firecrawl to scrape its results. Each snippet is Firecrawl's description of the result, its query-relevant highlight, as Exa's highlights and Parallel's excerpts are. A search is held at Firecrawl's 2 credits per 10 results.
A keyed `web_fetch` reads a PDF whole on Firecrawl's basic proxy. It is held at the most Firecrawl parses of one PDF, 10,000 pages ($9.90), so **a run whose cap has less than $9.90 left cannot fetch through keyed Firecrawl**. The new `pdfMaxPages` setting (1 to 10,000) caps both the pages read and the hold; a PDF cut at that cap reaches the agent starting `[PDF: pages 1-100 of N were read; …]`. Parallel, the default, is unaffected.
Each call is charged the `creditsUsed` Firecrawl reports, never above the hold. A `creditsUsed` that is missing, fractional, negative or not a number, or an answer that is not JSON or is past the 8 MiB bound, is charged the hold. The receipt line names the reported credits and the hold. A body asking for a proxy other than basic has no price and is not sent.
