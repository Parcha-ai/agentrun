---
packages: @parcha/agentrun-serve
kind: fix
---
A Browser computer (Browserbase or Kernel) is refused in words instead of failing at its run's start with "it gave no CDP connection": this server does not wire a Browser computer into a run yet. Saving an agent whose computer is `{ kind: "browser", ... }` is 422 with "Browser computers don't run on this server yet: use the browser tool (Settings → Tools) for web browsing."; a run of an agent saved with one before is refused at its start (409 `agent_not_runnable`) in the same words, before any run is made; and `GET /v2/computers` shows the browser kind not offered and its providers not ready, in those words. Sandbox, desktop and phone computers are unchanged. For web browsing, grant the agent the browser tool.
