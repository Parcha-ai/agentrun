---
packages: @parcha/agentrun-serve
kind: breaking
---
A run takes `labels` at its start (`POST /agents/{agent_id}/runs` and `POST /runs`): a map of the caller's own strings, at most 16 keys of 1 to 63 letters, digits, `.`, `_`, `-` or `/`, each value 1 to 256 characters with no control character and no lone UTF-16 surrogate. The run keeps them as given and serves them as `labels` on every read (`{}` when none), and `GET /runs` and `GET /agents/{agent_id}/runs` take `label=<key>:<value>`, once per request, to list only the runs holding that label. Labels out of bounds are `422` under `labels` or `labels.<key>`; a filter that does not read is `400`. The server reads nothing else from them, so they are no place for a secret.
- On Postgres the store applies migration `0011_run_labels` (a nullable `runs.labels` column) at the server's start.
- **Breaking for a SQLite data directory.** The store's SQLite schema is now version 12 (a run keeps its labels). A server or runner of this release refuses a data directory an earlier release set up, with `SchemaVersionUnknown`: start this release on a new, empty data directory and add your agents, MCP servers, keys and sign-ins there again, or keep the old directory with the earlier release. A runner upgraded before its server is refused the same way, never left reading runs without the column.
