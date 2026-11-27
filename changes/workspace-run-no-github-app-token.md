---
packages: @parcha/agentrun-serve
kind: fix
---
A run in a workspace (its agent made by a request that sent `AgentRun-Workspace`, or the run itself stamped with one) never gets a token of the server's GitHub App. Its `checkout: repository` or `checkout: pull_request` fetches the repository anonymously, so a public repository is checked out and a private one is not. Its `github_app` MCP server's calls are refused as on a server with no App. The runner reads the run's workspace at each claim, and a run it cannot find gets no token either. A run in no workspace, such as every run on a self-hosted install, still has the App's token minted for it.
