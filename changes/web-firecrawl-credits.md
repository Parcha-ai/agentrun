---
packages: @parcha/agentrun-web
kind: fix
---
Keyed Firecrawl is charged the credits Firecrawl reports, held at the most a call can cost. Before this, a search was held at 2 credits per 10 results and a scrape at 1, but Firecrawl bills each result it scrapes and each PDF page it parses. On 17 measured calls Firecrawl billed 6.47 times what was recorded, almost all of it in PDF pages.
Every keyed body now caps PDF parsing and pins Firecrawl's basic proxy. A search parses each result's PDF to 2 pages. A `web_fetch` parses a PDF to 100 pages, or to the new `pdfMaxPages` setting (1 to 10,000).
The hold is the worst case under those caps: for a search, 2 credits per 10 of its limit, rounded up, plus 2 a result; for a scrape, its page cap. The call is charged the `creditsUsed` Firecrawl reports, never above the hold.
A `creditsUsed` that is missing, fractional, negative, not a number, or in an answer that is not JSON is charged the hold. The receipt line names the reported credits and the hold.
A body asking for a proxy other than basic has no price and is not sent. A PDF cut at its cap reaches the agent starting `[PDF: pages 1-100 of N were read; …]`.
