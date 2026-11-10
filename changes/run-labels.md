---
packages: @parcha/agentrun-serve
kind: feature
---
A run takes `labels` at its start (`POST /agents/{agent_id}/runs` and `POST /runs`): a map of the caller's own strings, at most 16 keys of 1 to 63 letters, digits, `.`, `_`, `-` or `/`, each value 1 to 256 characters with no control character. The run keeps them as given and serves them as `labels` on every read (`{}` when none), and `GET /runs` and `GET /agents/{agent_id}/runs` take `label=<key>:<value>`, once per request, to list only the runs holding that label. Labels out of bounds are `422` under `labels` or `labels.<key>`; a filter that does not read is `400`. The server reads nothing else from them, so they are no place for a secret.
On Postgres the store applies migration `0003_run_labels` (a nullable `runs.labels` column) at the server's start; a SQLite store made by an earlier build of this version gets the column at the server's open, its runs reading as given none.
