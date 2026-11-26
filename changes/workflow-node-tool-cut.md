---
packages: @parcha/agentrun-serve
kind: fix
---
Workflow runs: a model node's tool answer (`web_search`, `web_fetch`) now passes the run's redactor before the node's model or the run's journal sees it, as an agentic run's tool answers do. Before, a search result or a page that echoed a key the run holds reached the node's model and was stored uncut. A web call's JSON is cut string by string, so it still parses and keeps its links.
