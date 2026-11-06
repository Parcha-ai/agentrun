---
packages: @parcha/agentrun-serve
kind: fix
---
A tool refused because it is set to deny now says where the deny was set, so a person changes the right setting: "Permission denied: mcp:docs/search is set to deny for this agent. Don't retry it." when the agent's own tool settings deny it, and "... on this server ..." when the server's do. The same goes for a shell tool following bash's setting, a workflow's call node (at save, at start and mid-run) and a learned workflow's check.
