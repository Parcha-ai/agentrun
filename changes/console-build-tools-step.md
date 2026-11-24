---
packages: @parcha/agentrun-serve
kind: feature
---
Console: the Build an agent page has a Tools step. Before the agent is created, pick its tools with the Detailed editor's own cards, the MCP servers saved in Settings (a Composio Gmail server, say) among them, and where it runs (on the server or in a sandbox box). The picks go on the playground's create request (`definition.tools`, `definition.place`) and into the coding-agent prompt. A step left alone sends the same request as before: no tools, no place.
