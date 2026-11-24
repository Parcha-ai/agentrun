---
packages: @parcha/agentrun-serve
kind: fix
---
A claude-agent or codex run whose web_search resolves to the harness's own search (`native`) is no longer also handed the server's web_search tool beside it. On the runner it was given both, so the model could search through either one.
