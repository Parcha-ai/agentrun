---
packages: @parcha/agentrun-serve
kind: fix
---
The owner's MCP server edits are no longer lost to a write that read the server earlier. A tools refresh (the owner's or the API token's) used to write back the address, auth type and prices it read over a save that landed while it listed, including a repricing in the same millisecond. Now it lands only on the server as it read it, and otherwise retries on the fresh row or is refused in words with nothing written. The owner's OAuth sign-in over a server an API token saved now makes it the owner's, as the owner's save already did. Over a server an API token saved, whose reads show only its origin, the owner's save, sign-in and preview no longer take that shown address (`https://host/…`) for the saved one: they answer `422` on `url` (`not_an_option`), so the owner's credential goes only to an address the owner named in full.
