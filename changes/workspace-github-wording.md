---
packages: @parcha/agentrun-serve
kind: fix
---
A run in a workspace that could not use the server's GitHub App was told the server had none: its failed checkout of a private repository said "this server has no GitHub App", and its `github_app` MCP calls said "this server has no GitHub App set up for its runs (Settings → GitHub)", both false on a server with a connected App. Both now say "a run in a workspace doesn't use this server's GitHub App, so only public repositories are read", and so does a refused listing of a `github_app` server's tools for such a run. A run in no workspace keeps its words.
