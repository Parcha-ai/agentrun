---
packages: @parcha/agentrun-serve
kind: feature
---
The MCP tool `runs_start` takes `max_cost_usd`, the run's spend cap in dollars above 0, as `POST /v2/agents/{agent_id}/runs` does. A native client that starts runs over MCP can now cap what each one spends. Before, the tool's schema left the field out, so clients and models never sent it. A run that reaches its cap pauses at `input_required` with pending kind `budget`, as before.
