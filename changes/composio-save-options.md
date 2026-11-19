---
packages: @parcha/agentrun-serve
kind: feature
---
`PUT /settings/mcp-servers/{name}/composio` takes `price_usd` and `auth_config_id`. `price_usd` prices every granted action at that amount a call, held under the run's cap and booked in `cost.usd` as any priced MCP tool; a re-save that names none keeps the prices. `auth_config_id` (`ac_…`) makes the server and its connect link against an auth config you already have, read first and never deleted; its triggers run as an account under that config. A server saved before this keeps the managed config's link.
