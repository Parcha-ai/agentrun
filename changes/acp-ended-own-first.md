---
packages: @parcha/agentrun-harness-acp
kind: fix
---
A late MCP call of a call that ended first (a cancel can report a call failed while its MCP call is on its way) takes its own announcement again before a live one that names no tool or reports no input, such as the agent's own think, whether that one was announced before the MCP call or while it held. Before, it could take that one's id: on a recipe with no announces field the think's, and on any recipe one announced during the hold.
