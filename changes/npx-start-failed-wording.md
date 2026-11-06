---
packages: @parcha/agentrun
kind: fix
---
When the server stops before printing anything on stdout (its reason on stderr only, such as another server holding the data root), `npx @parcha/agentrun` now says "AgentRun did not start; the server's own message, if it gave one, is above." where it said the server printed nothing.
