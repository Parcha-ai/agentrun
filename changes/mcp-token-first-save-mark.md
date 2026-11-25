---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP server the API token saves under a new name is the token's from the moment it exists. The token's first save used to write the server, then the record saying the token saved it, in two writes. An owner's preview, save or sign-in start that landed between them, sent at the address reads show (its origin), was taken as the owner naming the token's address, and the owner's credential went there. Both are now written in one store transaction, so such a request is refused under `url` (`422`), as it is once the save is done. An owner's delete of a server under that name that lands while the token saves the name again no longer drops the token's new record either: the delete removes a server's records only while they are still the ones it read.
