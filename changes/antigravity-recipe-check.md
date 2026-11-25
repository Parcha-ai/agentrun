---
packages: @parcha/agentrun-harness-acp, @parcha/agentrun-serve
kind: fix
---
The Antigravity example recipe names agy's calls of AgentRun's tools by the field agy writes them in, `name` (`mcp_agentrun_<tool>`): `announces` with `prefix: "mcp_agentrun_"`, and `extras: ["toolSummary"]`, so the summary agy adds to the arguments it reports is left out when the call is matched to its MCP call. agy asks permission for every MCP call, so the recipe declares the title tie: a request titled `Run mcp_agentrun_<tool>`, the whole text, for a call `announces` named as that same tool, is answered allow once, with the host's gate asked at the MCP call itself, as for Cursor. The Antigravity example recipe now passes `harness-check` (agy 1.5.14): it declares MCP over stdio, since agy advertises no MCP over HTTP, and names `.gemini/antigravity-cli/conversations` as its state, so a resume after a kill and another runner both load the conversation.
