---
packages: @parcha/agentrun-harness-acp
kind: fix
---
An ACP agent's calls of AgentRun's tools are known in Google's agy CLI's form too: named `mcp_<server>_<tool>` and titled `Run mcp_<server>_<tool>`, `<server>` the name AgentRun gives its MCP server, the whole text, never a look-alike. Its permission request for such a call is answered allow once, with the host's gate asked at the MCP call itself, as for Goose and Cursor. The `toolSummary` agy adds to the arguments it reports is left out when the call is matched to its MCP call. The Antigravity example recipe now passes `harness-check` (agy 1.5.14): it declares MCP over stdio, since agy advertises no MCP over HTTP, and names `.gemini/antigravity-cli/conversations` as its state, so a resume after a kill and another runner both load the conversation.
