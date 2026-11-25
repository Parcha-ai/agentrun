---
packages: @parcha/agentrun-harness-acp
kind: fix
---
Under Google Antigravity, a tool name of 44 to 51 characters works again, and a longer one no longer stops the run. The MCP server name each start gets was `agentrun` and 8 hex digits, so agy's 64-character cap left a tool's own name 43 characters, and any longer name in the listing (an `mcp__composio__<slug>`, say) refused every start. The name is now `ar` and 6 hex digits. That is as long as `agentrun`, so a tool fits up to 51 characters, as it did before. A tool still over the cap is left out of the tools agy is given at that start, and the run gets a notice naming it while the run goes on. The fake ACP agent gains a `{ sayTools }` step that answers with the names its MCP server lists.
