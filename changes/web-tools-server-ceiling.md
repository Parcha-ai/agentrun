---
packages: @parcha/agentrun-serve
kind: breaking
---
Who breaks: an agent whose own `tool_settings` pick `firecrawl-keyless`, `exa-keyless`, `auto` or `parallel` for `web_search` or `web_fetch` on a server set to `kernel` for `web_fetch`, or to `native` or `off` for `web_search`, and an agent that picks `native` for `web_search` on a server set to `off`. The server's setting is now a ceiling the agent's pick cannot raise: the pick resolves as the server's setting does, so its URLs and queries go to no keyless service and not to Parallel. A server's `deny` stays absolute.
- To let agents use Parallel, set it server-wide (`PUT /v2/settings/tools` with `parallel`); a server pick of `auto`, `firecrawl-keyless`, `exa-keyless` or `parallel` is still only a default an agent's pick replaces.
- Where the harness has no native search, such an agent's `web_search` under `native` is unavailable, and its new runs are refused (409). A run that already exists is not refused: its follow-up, resume or reclaim goes on with `web_search` unavailable, each call answering that it does not run here.
- The way back for `web_search`: set the server's `web_search` to `auto`, `firecrawl-keyless`, `exa-keyless` or `parallel`. For `web_fetch`: set the server's `web_fetch` to `auto`, `firecrawl-keyless` or `parallel`.
- A server setting applies at a run's next claim (its start, a follow-up, a resume or a reclaim). A claim keeps the plane it began with to its end, through any approval it waits on while it holds the run.
- Tool settings a claim cannot read fail closed: a capability kept on a keyless service or on Parallel runs nothing, its tool saying the server's tool settings could not be read. One a claim finds past a ceiling with nothing the setting allows in its place runs nothing either, never the value it was kept with.
- Capabilities' `why` says when the server's setting is a ceiling over an agent's pick ("the server's setting, kernel, is a ceiling over this agent's pick of auto").
