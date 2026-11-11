---
packages: @parcha/agentrun-serve
kind: fix
---
A Claude Code or Codex run whose MCP call waits for approval shows the call's result row with the gate's waiting words ("This mcp:… call waits for a person's approval…"), as a pi run does. The row shows from the call's ask until the call is sent or ends. Once it runs, is refused or is withdrawn, the row is the call's outcome alone.
