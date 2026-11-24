---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
Add from Composio picks the toolkit from Composio's list (`POST /v2/settings/mcp-servers/composio/toolkits`, owner's session only).
A refresh of a Composio server reads its connected account; every read then carries `composio_account` (`state`, `labels`, `checked_at`), and a label may be an email.
