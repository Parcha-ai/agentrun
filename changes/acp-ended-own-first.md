---
packages: @parcha/agentrun-harness-acp
kind: fix
---
A late MCP call of a call that ended first (a cancel can report a call failed while its MCP call is on its way) takes its own announcement again before a live one that matches it less closely: one naming no tool, or reporting no input, such as the agent's own think. Before, on a recipe with no announces field, it could take the think's id.
