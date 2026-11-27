---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
An agent can turn Jev off for its own web tools: `jev: "off"` on `web_search` or `web_fetch` in its `definition.tool_settings` turns it off for both, as `AGENTRUN_WEB_JEV_OFF=1` does for every agent. Its runs' planes carry it at every launch and claim, and no TypeSafe key is handed. `off` is the one value; the server's own tool settings refuse it. The console's agent editor has a Jev switch beside the web tools.
