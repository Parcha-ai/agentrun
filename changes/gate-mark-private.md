---
packages: @parcha/agentrun-serve
kind: fix
---
The mark by which the MCP gateway tells the tool gate it gates a tool itself (`GATED_BY_GATEWAY`) is a private symbol, no longer `Symbol.for`'s global one, so `Symbol.for("agentrun.gatedByGateway")` can no longer recreate it. Only code that imports the export can set the mark.
