---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP server saved under a name is now always made after every earlier server of that name that a record still describes. This holds even within the same millisecond, after the clock stepped back, or when another server process sharing the database made the earlier one. Before, the new server could get the same creation time, and an owner's removal of the earlier server could then drop the record saying the API token saved the new one, so the new server read as the owner's.
