---
packages: @parcha/agentrun-serve
kind: breaking
---
Who breaks: an agent whose own `tool_settings` pick `firecrawl-keyless`, `exa-keyless` or `auto` for `web_search` or `web_fetch` on a server set to `kernel` for `web_fetch`, or to `native` or `off` for `web_search`. The server's setting is now a ceiling the agent's pick cannot raise: its pick resolves as the server's setting does, so its URLs and queries go to no keyless service and, through `auto`, not to Parallel on the server's key. Parallel picked by name, and under `off` a native search picked by name, are still the agent's. A server's `deny` stays absolute.
- Where the harness has no native search, such an agent's `web_search` under `native` is unavailable, and its new runs are refused (409). A run that already exists is not refused: its follow-up, resume or reclaim goes on with `web_search` unavailable, each call answering that it does not run here.
- Under `native`, a workflow's `web_search` on its default harness (pi) is unavailable, since a workflow names no model for a native search to ask, so a workflow whose steps call `web_search` is refused at its start (409).
- The way back for `web_search`: set the server's `web_search` to `auto`, `firecrawl-keyless` or `exa-keyless` (`PUT /v2/settings/tools`), or pick `parallel` for the agent where the server holds a Parallel key. For `web_fetch`: set the server's `web_fetch` to `auto` or `firecrawl-keyless`.
- A server setting applies at a run's next claim (its start, a follow-up, a resume or a reclaim). A claim keeps the plane it began with to its end, through any approval it waits on while it holds the run.
- Tool settings a claim cannot read fail closed: a keyless pick, or Parallel from `auto`, runs nothing, its tool saying the server's tool settings could not be read.
- Capabilities' `why` says when the server's setting is a ceiling over an agent's pick ("the server's setting, kernel, is a ceiling over this agent's pick of auto").
- A page `web_fetch` read directly because keyless Firecrawl gave none now says why in a few words, in `fallback` (such as `firecrawl quota spent`, `firecrawl rate-limited` or `firecrawl page 404`), never the URL. A URL the guard refuses carries the guard's own refusal and no `fallback`.
- A search that turns Firecrawl off for the run while keyless Exa waits out a rate limit now says both: Firecrawl is not asked again, and search is busy for the seconds left of Exa's wait.
