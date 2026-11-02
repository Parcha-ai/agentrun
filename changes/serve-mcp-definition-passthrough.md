---
packages: @parcha/agentrun-serve
kind: feature
---
The MCP tools `agents_create` and `agents_revise` take an optional `definition`: any other definition field, passed through as it is to `POST /v2/agents` or the definition `PUT`, whose own checks answer for each. A field the server takes later (an agent's `place` now) needs no change to the tools, and a field the route refuses is its own `422`, by field. A field named outright wins over the same one in `definition`, and `agents_revise` keeps every field neither names.
