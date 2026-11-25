---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP server the API token saves under a new name is the token's from the moment it exists. The token's first save used to write the server, then the record saying the token saved it, in two writes. An owner's preview, save or sign-in start that landed between them, sent at the address reads show (its origin), was taken as the owner naming the token's address, and the owner's credential went there. Both are now written in one store transaction, so such a request is refused under `url` (`422`), as it is once the save is done.
