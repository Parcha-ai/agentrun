---
packages: @parcha/agentrun-serve
kind: fix
---
Each `web_search` with Jev on also sends TypeSafe each result's published date, when the provider gives one, along with its URL, title and snippet. Searches already sent the date, but GET /capabilities' `why` and the README left it out. Both now name it.
