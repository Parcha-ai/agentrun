---
packages: @parcha/agentrun-serve
kind: feature
---
`PUT /settings/mcp-servers/{name}/composio` takes two optional fields. `price_usd` (a number from 0 to 100) prices every granted action the server lists at that amount a call, as the server's `prices`: each call is held under its run's cap and booked as the run's tool cost, so it shows in its trace span's `usd` and the run's `cost.usd`. Before, every Composio call read $0, not metered. `auth_config_id` (`ac_…`) makes the MCP server and its connect link against an auth config you already have at Composio, such as your own OAuth app's, in place of the Composio-managed one. It is read first: one Composio doesn't know, of another toolkit, or disabled is `422` under `auth_config_id` before anything is made, and a save never deletes it. A malformed value of either is `422 input_invalid` on its field before Composio is asked anything. A save with neither works as before.
