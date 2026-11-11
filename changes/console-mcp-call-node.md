---
packages: repo
kind: feature
---
The console reads a call node that runs an MCP server's tool (`tool: "mcp:<server>/<tool>"`) as "<tool> on <server>" with an MCP mark, instead of the raw `mcp:` key: on the workflow graph (a workflow agent's tab, the editor, a run's graph and a learned workflow in the Learning tab, its hover too), in a run's node details (its header and its tool call card, the raw key on hover) and in the editor's graph, while the editor's text, and what it saves, keep the key as written. Every other call node reads as before.
Upgrading: nothing to do.
