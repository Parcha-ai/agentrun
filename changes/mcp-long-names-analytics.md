---
packages: @parcha/agentrun-serve
kind: fix
---
The analytics page's top tools name an MCP tool whose `mcp__<server>__<tool>` is longer than 52 characters by its catalog name (`slack · SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION`), as its timeline does, not by the hashed name the harness called it. Runs on claude-agent, codex and opencode now count their tool calls there too; their metrics counted none. Runs that ended before this change keep the metrics they stored.
