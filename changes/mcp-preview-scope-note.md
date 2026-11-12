---
packages: @parcha/agentrun-serve
kind: docs
---
An MCP server's preview says what its tool list is: the tools the server offers, not what the credential allows. A read-only token still lists the server's write tools, and a call the token can't make is refused by the MCP server when a run makes it. Settings → MCP servers shows the note with every preview, and POST /settings/mcp-servers/preview's description says the same.
