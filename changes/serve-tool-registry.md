---
packages: @parcha/agentrun-serve
kind: feature
---
The tools a revision may name are one closed table: each name is how the run's process binds it and the environment variables it needs, and nothing outside the table can be named or loaded. `GET /v2/capabilities` now lists `tools` as objects, `{name, summary, nodes, available}` with `missing` (the variables' names) when a tool is not available here, where it listed names; a run of a revision that names a tool whose variables are not set is refused with `409 agent_not_runnable` and `details.missing`. `read`, `write`, `edit` and `ask_person` are the table's first entries, unchanged, and the page marks a tool the server cannot bind with the variables it needs.
