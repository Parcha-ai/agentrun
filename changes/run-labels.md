---
packages: @parcha/agentrun-serve
kind: feature
---
A run takes `labels` at its start (`POST /agents/{agent_id}/runs` and `POST /runs`): a map of the caller's own strings, at most 16 keys of 1 to 63 letters, digits, `.`, `_`, `-` or `/`, each value 1 to 256 characters with no control character and no lone UTF-16 surrogate. The run keeps them as given and serves them as `labels` on every read (`{}` when none), and `GET /runs` and `GET /agents/{agent_id}/runs` take `label=<key>:<value>`, once per request, to list only the runs holding that label. Labels out of bounds are `422` under `labels` or `labels.<key>`; a filter that does not read is `400`. The server reads nothing else from them, so they are no place for a secret.
- On Postgres the store applies migration `0015_run_labels` (a nullable `runs.labels` column) at the server's start.
- On SQLite the store keeps its schema version: the server adds the nullable `runs.labels` column at its open to a data directory an earlier release set up, and every run started before reads as given none. Start the upgraded server before its runners: a runner of this release opening a data directory its server has not opened yet is refused with "Start the AgentRun server to add each run's labels before opening a runner", and nothing in the directory changes.
