---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/runs/{run_id}` gains `cost.tools_usd`: the part of `cost.usd` its paid tool calls cost (monid, priced MCP tools, Parallel, browser time), never added to it. A paid call in a learning turn is in `learning_usd` instead. Null while a charge is unknown, while the run is at work, for a learning run a follow-up opened again, and for an imported, native or SDK run.
