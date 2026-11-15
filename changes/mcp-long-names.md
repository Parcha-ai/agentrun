---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP tool whose `mcp__<server>__<tool>` is longer than 52 characters can be granted. Composio's Slack tool for a thread's replies (`mcp:slack/SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION`, 58 characters) was refused at the save, so the templates that need it could not be applied. Every harness now calls such a tool by its name cut to 52 characters with a hash of its catalog name, and its timeline rows, settings and approvals still name it `mcp:<server>/<tool>`. Two grants that would be called by one such name are refused, naming both.
