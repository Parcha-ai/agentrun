---
packages: @parcha/agentrun-serve
kind: feature
---
A learned workflow can call the agent's MCP tools. A call node `{"node": "call", "via": "tool", "tool": "mcp:<server>/<tool>", "args": {…}, "out": …}` runs that tool through the run's own MCP, the same path the harness's own MCP calls take. It answers the tool's text as JSON when it parses, else `{ "text": … }`.

The call is held to the run's tool gate:
- **allow:** it runs, and its price is booked as the run's tool cost, under the run's cap.
- **deny:** the workflow is refused before any node runs, in the gate's words, and nothing is sent.
- **ask:** the `learned_workflow` call asks once for approval, and the run parks; the owner's allow runs that call's MCP nodes.

A stop cuts an MCP call in flight. A node may name only an MCP tool that the agent's revision grants and the run's pin holds.
