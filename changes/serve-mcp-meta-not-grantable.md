---
packages: @parcha/agentrun-serve
kind: feature
---
A known MCP meta tool, one that runs other actions by name (Composio's `COMPOSIO_MULTI_EXECUTE_TOOL` and workbench, Klavis Strata's `execute_action`, Zapier's execute and `write_code_action`, Arcade's `UseTool`, Docker's `mcp-exec` and code mode, Cloudflare's `portal_execute` and code mode), is not grantable: a grant of it can't name the real action. A server's tools read it `grantable: false` with the reason, a save that grants it is `422`, and a run that pinned one is refused at its launch. Upgrading: an agent that grants one must grant the server's direct tools instead.
