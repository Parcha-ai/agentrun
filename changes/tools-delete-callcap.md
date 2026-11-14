---
packages: @parcha/agentrun-serve
kind: breaking
---
A tool-call budget is removed: `max_tool_calls` on an agent definition and `budget.tool_calls` in a template manifest are refused as unknown fields, and the `subagent` tool no longer takes `max_tool_calls`. The count only ever held on pi; the run's spend cap and its wrap-up stop a runaway loop on every harness. Put a call count in the instructions and set `per_run_usd` (a template's `budget` is now `{per_run_usd}`, required when `budget` is given).
