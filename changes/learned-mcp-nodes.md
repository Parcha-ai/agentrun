---
packages: @parcha/agentrun-serve
kind: feature
---
A learned workflow can call the agent's MCP tools. A call node `{"node": "call", "via": "tool", "tool": "mcp:<server>/<tool>", "args": {…}, "out": …}` runs that tool through the run's own MCP, the same path the harness's own MCP calls take. It answers the tool's text as JSON when it parses, else `{ "text": … }`.

The call is held to the run's tool gate:
- **allow:** it runs, and its price is booked as the run's tool cost, under the run's cap.
- **deny:** the workflow is refused before any node runs, in the gate's words, and nothing is sent.
- **ask:** the `learned_workflow` call asks once for approval, and the run parks; the owner's allow runs that call's MCP nodes, and only that call's.

The approval card of a `learned_workflow` call whose workflow calls MCP tools set to ask leads with two new fields, before the call's own input: `mcp_arguments`, which says the tools' arguments are "decided by the workflow while it runs, from its input and its earlier steps", and `mcp_calls`, every one of those tools by name (`mcp:<server>/<tool>`).

On a server with accounts off (AGENTRUN_ACCOUNTS=0, or AGENTRUN_API_ONLY=1), no one can approve, so such a call is refused at once and never parks: "The learned workflow <name> was not run: Permission denied: mcp:<server>/<tool> needs the owner's approval, and this server has accounts off (AGENTRUN_ACCOUNTS=0), so no one can give it: set the tool to allow or deny in the agent's Tools. It was not run: nothing was sent and nothing was charged."

A workflow whose ask-set MCP tools are too many to all show on the 2 KB approval card is refused instead of asked, so no approval covers a tool its approver couldn't see: "The learned workflow <name> was not run: its approval card can't name all <n> MCP tools it would call that are set to ask: set some of them to allow or deny for this agent."

A stop cuts an MCP call in flight. A node may name only an MCP tool that the agent's revision grants and the run's pin holds.
Upgrading: nothing to do. An API client that reads a `learned_workflow` call's approval card (its pending approval's arguments) finds `mcp_arguments` and `mcp_calls` first when the workflow calls MCP tools set to ask; the call's own arguments follow them unchanged.
