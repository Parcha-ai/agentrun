---
packages: @parcha/agentrun-serve
kind: fix
---
An agent's new revision is checked against the agent's own workspace, whoever writes it, on every path that saves one: an edit, a template update, a source sync and an inline run's new version. Its MCP servers are mapped and pinned from that workspace, and an agent in a workspace can't name a computer paired with the server even when the request that saves it carries no `AgentRun-Workspace` header. Before, the paired-computer check and the source-sync and inline checks read the request's workspace: an inline run by the token with no header, of an external agent a workspace backfill had put in a workspace, could save a version naming the server's paired computer.
