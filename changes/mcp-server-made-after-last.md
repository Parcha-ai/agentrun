---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP server saved under a name within the same millisecond as the last server of that name, or after the clock stepped back, is now always a new server. Its creation time is past the last one's. Before, an owner's removal of the earlier server could drop the record saying the API token saved the new one, and the new server then read as the owner's.
