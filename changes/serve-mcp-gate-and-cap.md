---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
MCP tools pass the run's one tool gate and its one spend cap. Each call enters the gate as `mcp:<server>/<tool>` (`mcp:<server>/*` sets all of a server's tools): a denied call is refused and nothing is sent; one set to ask, the default for MCP tools, parks and ends the turn on pi and claude-agent alike, and the owner's allow runs it once and resumes the run with its result. `PUT /v2/settings/mcp-servers/{name}` takes `prices` (USD a call, per listed tool): a priced call is held at its price under `max_cost_usd`, refused unsent when the cap cannot take it, and booked as the run's tool cost; an unpriced call runs "not metered", a timeline row and the usage row's `not_metered`, and `GET /usage`'s `tools` line counts them (`not_metered_calls`).
