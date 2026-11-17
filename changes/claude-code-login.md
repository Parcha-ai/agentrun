---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A self-hosted server one person runs can run Claude Agent on that person's Claude plan through the Claude Code CLI's own login on the same machine: `PUT /v2/settings/claude-login` with `only_me: true` turns it on, and the CLI keeps the login and calls Anthropic itself. AgentRun only asks the CLI `claude auth status`; it never reads, stores or relays the login. A run on it gets no model key, endpoint or proxy, books its tokens and no dollars (`cost.plan.on: "claude_code"`), and fails in words when the login is signed out. A server where more than one person can start runs refuses the mode. It exists only on a server that listens on loopback: one bound to `0.0.0.0` or another address has it off by default. `AGENTRUN_CLAUDE_CODE_LOGIN=off` removes it anywhere, routes and all, and `on` allows it past loopback.
