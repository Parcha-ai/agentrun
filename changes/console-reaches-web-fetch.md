---
packages: repo
kind: fix
---
The console's agent editor no longer tells an agent with `web_fetch` (or `web_search`) that it can't reach the web: any of `fetch_page`, `web_fetch` and `web_search` reaches it, one named list (`WEB_TOOLS`), since the server's capabilities mark no tool as web-reaching. An agent with none of them is told which of them its harness runs on this server, to tick, or that its harness runs none. The tools step shows what each tool does, from each tool's `summary` in capabilities.
