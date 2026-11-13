---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A web_search setting of deny or ask now applies to a Claude Code or Codex run's own web search at its next search, including a run that started while it was allow. Before, the setting was read only when the run started, so a run that started with native search kept searching after the setting changed.
- Claude Code: each WebSearch asks the run's gate before it runs, as a host tool's call does. A deny refuses it in the gate's words. An ask parks the run on the person with nothing searched; once they allow it, the model's next search with the same query runs once, with no second card.
- Codex: its search runs inside the provider's model request, so its proxy reads web_search's setting before each request and offers the provider its search only while the setting is allow. A failed read offers no search.
- `SessionIO.permission(tool)` (agentrun-kernel) is the host's setting for a harness's own tool at the time of the read. The runner reads it from the store each time. `ProviderPolicy.apply` may return a promise.
- A runner run whose plane resolves web_search to native now gets the harness's own search (#2458). The runner had built the run's environment without its plane, so Claude Code and Codex runs on a runner never had it on.
