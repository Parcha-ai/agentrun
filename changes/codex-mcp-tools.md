---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-codex
kind: feature
---
Agents on codex call a saved MCP server's tools: grant `mcp:<server>/<tool>` in `definition.tools`, as on pi and claude-agent, and `features.mcp_client.harnesses` now lists codex. Codex is given each granted tool as one of the session's host tools (a dynamic tool, `mcp_<server>__<tool>` on Codex's wire, since Codex reserves `mcp__` names, and `mcp__<server>__<tool>` to the run), called from the run's process through the run's one gate and spend cap, as pi's are: Codex's own MCP client is not used, and Codex never holds a server's credential. A grant of a tool whose schema Codex would drop or retype is refused at the save. The timeline reads `<server> · <tool>`. An adapter now says whether its harness has an MCP client of its own (`capabilities().mcpClient`); the Codex adapter refuses `spec.mcp`.
