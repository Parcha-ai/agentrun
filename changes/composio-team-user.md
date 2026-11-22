---
packages: @parcha/agentrun-serve
kind: fix
---
A Composio user id may hold a `:`, so a run's `mcp_auth` can bind a per-run Composio server to a team's connected account by the user a host names it with (`team:<tenant>`), and a preset save may name such a user. A space, a slash and a `~` are still refused.
