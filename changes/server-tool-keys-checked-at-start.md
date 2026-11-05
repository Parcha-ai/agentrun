---
packages: @parcha/agentrun-serve
kind: feature
---
A tool's key the server is started with (Browserbase's, Parallel's, monid's, TypeSafe's) is checked once as the server starts, with the same call that costs nothing a saved key gets, in the background, so the start never waits on it. `GET /v2/settings/tool-keys` shows its `check`: `accepted`, `not_checked` and why, or `refused` (`Browserbase refused BROWSERBASE_API_KEY (401: Unauthorized) when this server started: set the right one where AgentRun starts, then restart it`). A tool that needs a refused key (the browser on Browserbase's, monid's tools on monid's) reads unavailable in capabilities with the same words, instead of available until a run fails.
