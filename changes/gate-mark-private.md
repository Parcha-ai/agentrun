---
packages: @parcha/agentrun-serve
kind: fix
---
The mark by which the MCP gateway tells the tool gate it gates a tool itself (`GATED_BY_GATEWAY`) is a private symbol, no longer `Symbol.for`'s global one, so no other code in the process can forge it and take a tool past the gate.
