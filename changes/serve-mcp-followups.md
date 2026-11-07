---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow that grants an MCP tool, in its `tools` or on a node, is refused at save (`422`, "a workflow's nodes don't bind MCP tools here yet; grant it to an agentic agent"): no workflow node binds an MCP tool, so its run went without it. Every MCP grant now goes through one check, and a known meta tool keeps the meta rule's words wherever a workflow names it. Upgrading: grant MCP tools to an agentic agent.
- A run refused for a known MCP meta tool names it under `error.details.not_grantable` (`[{tool, reason}]`), no longer under `details.unbound`.
- The meta-tool rule strips every final dot of a server's host (`strata.klavis.ai..` is Klavis's), not only one.
- A tool's `x-mcp-header` check walks schema keywords only, as the MCP SDK client's does: a value under `default`, `examples`, `const` or `enum`, or an annotation, no longer refuses the tool.
