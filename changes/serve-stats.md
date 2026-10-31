---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
`GET /v2/stats` answers a dashboard's first page in one request: how many agents there are, the runs in all and how many are active, need input, failed or have a status this server cannot tell, each agent's run count, the total cost, and what is archived. It is this server's own route, outside the contract, marked `x-agentrun-serve: "stats/1"` in `/v2/openapi.json` with a closed schema. A running run is counted in exactly one of `active`, `needs_input` and `status_unknown`; one this server does not hold is `status_unknown`. The total cost sums only the runs that ended with a known cost and is null when none did, never $0. `unknown_runs` counts the rest. Archived agents and runs are left out of every number and counted on their own. Every number comes from SQL aggregates over `store.sqlite`, and no run's files are opened.
The agent store gains `stats()`, which answers those counts and sums, and an index on `runs` (`runs_by_state`) added without a new store version. An earlier version still opens the file.
