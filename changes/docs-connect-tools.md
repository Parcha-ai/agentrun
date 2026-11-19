---
packages: repo
kind: docs
---
`docs/connect-tools.md`, "Give an agent tools", says how to let an agent use a service such as Sentry, GitHub or Slack without putting a token in its box: the service's own MCP server with OAuth first, then GitHub through the built-in GitHub App, then Composio, and as a last resort your own read-only MCP server on loopback (`AGENTRUN_MCP_ALLOW_LOOPBACK=1`, a single-user machine only). It also says how to give an agent a saved server's tools and how to let an unattended agent use them. The setup skill, the README and the server README link to it.
