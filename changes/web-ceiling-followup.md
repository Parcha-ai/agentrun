---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
An agent's tools on GET /v2/agents/{agent_id} now name the server's ceiling. Where the server's `kernel` for `web_fetch`, or its `native` or `off` for `web_search`, holds down the agent's own pick, the tool carries `ceiling` with that setting, next to `resolved`, the setting that runs. `provider` stays the agent's own pick, so the editor still shows what the agent asked for.
- A run in a process of its own is handed keys for its capped plane only. A run kept on Parallel and claimed after the server was set to `kernel` or `native` is no longer handed `PARALLEL_API_KEY`, which the run never used.
- The README and the settings description now say what the ceiling covers: `web_search` and `web_fetch`, not every way a run reaches the web. `browser`, `bash`, MCP and catalog tools, Jev's ranking, a workflow's `parallel` decision provider and a native job's own CLI are outside it. `deny`, read at each call, is the setting that stops a claim already running.
- The README no longer says a Parallel key keeps `web_fetch` URLs on the server: with one, `auto` is Parallel's extract, which sends Parallel each URL.
