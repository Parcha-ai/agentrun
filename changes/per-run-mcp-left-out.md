---
packages: @parcha/agentrun-serve
kind: fix
---
MCP: when a run was handed no credential for a per_run server (no `mcp_auth` for it), or no account for a per-run Composio server, the model is no longer offered that server's tools. Before, the model saw the tools and every call came back refused. The run's timeline now says which server was left out and why, in the same words the refusal used. A message that hands the credential brings the tools back the next time the run picks up work, and a run handed the credential at the start gets them as before. This applies to pi, Claude Code, OpenCode and the ACP agents, which take their tools again each time a run picks up work. Codex is the exception: it keeps the tools its thread started with, and a resume can't add new ones. A Codex run therefore keeps listing the server's tools, and their calls are refused, with nothing sent, until the credential comes.
