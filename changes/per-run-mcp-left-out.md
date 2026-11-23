---
packages: @parcha/agentrun-serve
kind: fix
---
MCP: a run that was handed no credential for a per_run server (no `mcp_auth` for it), or no account for a per-run Composio server, no longer offers that server's tools to the model. Before, the model saw the tools and every call came back refused. The run's timeline now says which server was left out and why, in the same words the refusal used. A run handed the credential gets the tools as before. If the credential comes with a message while the run is still working, the server's tools are offered from the run's next start: after it parks, or with a message once it has finished. A call that still names a left-out server is refused, and nothing is sent.
