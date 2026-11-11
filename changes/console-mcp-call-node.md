---
packages: repo
kind: feature
---
The console's workflow graph (a workflow agent's tab, the editor, a run's graph and a learned workflow in the Learning tab) draws a call node that runs an MCP server's tool (`tool: "mcp:<server>/<tool>"`) as "call · <tool> on <server>" with an MCP badge, and its hover says so, instead of the raw `mcp:` key. Every other call node reads as before.
Upgrading: nothing to do.
