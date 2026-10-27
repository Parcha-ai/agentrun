---
packages: @parcha/pi-browser
kind: feature
---
`@parcha/pi-browser`: `web_search` and `web_fetch`: your agent can search the web and fetch a page's content as a tool call. Searches return results with a short redacted snippet when one is available; fetch returns the page text (and falls back to a raw fetch for files the fetch service can't convert, e.g. a PDF your extractor reads). Providers are tried in order with a fallback, so a search or fetch still answers when the first provider is unavailable.
