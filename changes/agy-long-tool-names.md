---
packages: @parcha/agentrun-harness-acp
kind: fix
---
Under Antigravity, a tool of AgentRun's named 44 to 51 characters no longer refuses the start. The start's own name for AgentRun's MCP server is now `ar` and 6 random hex digits, as long as `agentrun`, so a tool's own name may again be up to 51 characters under agy's 64-character cap. A longer tool is left out of the tools agy is given at that start. The run gets a notice naming it and goes on with the rest. The fake ACP agent (`./testing`) gains a `{ sayTools }` step that answers with the names its MCP server lists.
