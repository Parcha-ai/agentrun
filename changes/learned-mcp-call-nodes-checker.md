---
packages: @parcha/agentrun-serve
kind: feature
---
A learned workflow draft may run an MCP tool in a call node (`"via": "tool"`, `"tool": "mcp:<server>/<tool>"`) when the agent's revision grants it, by its own name or under its server's wildcard `mcp:<server>/*` (read against the tools the server lists), and its gate allows it; a draft naming any other is refused, and one the gate holds is refused in the gate's words. The end-of-run turn's draft ask says what each such tool takes and gives, from its server's listing. The grader is told, under each draft, the MCP tools its call nodes run, by server and tool, and holds the draft for its owner's OK when one writes or sends: the learned workflow runs it unattended at every call. A draft's dry run synthesizes an MCP node's output from its `out`, as any call's, and sends nothing.
Upgrading: nothing to do.
