---
packages: @parcha/agentrun-serve
kind: fix
---
The runner beside a local install now holds its loopback requests to the rule the server's settings routes use: never at the server's own ports (where it listens, and its public address when that is on loopback). The server tells that runner its addresses as it starts (`Serve.own`, `runnerBeside`'s `mcpOwn`). An MCP server's call, an authorization server's refresh or a pin's listing at one of those ports is refused unsent, in the server's words.
