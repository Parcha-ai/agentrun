---
packages: @parcha/agentrun-serve
kind: fix
---
Console: the agent editor and Build an agent's Tools step now share one tool picker, so the filter, the "No tool matches" line and the MCP servers read behave the same in both. Build an agent hands the coding agent the create request it picked (tools and place) instead of a separate list.
