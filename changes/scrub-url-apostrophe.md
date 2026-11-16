---
packages: @parcha/agentrun-serve
kind: fix
---
A URL in a timeline row's text (a tool's result and its preview, a page's title, a decision's sources, a note) never shows a query value after an apostrophe. An apostrophe inside a URL (`https://books.example/O'Reilly?token=…`, a query's `q='rust'`) is now part of the URL, so its whole query is scrubbed; one that closes a quote around a URL stays outside it, as a sentence's punctuation does.
