---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
What an upgrader of a client or a script against `/v2` changes:
- `GET` and `PUT /v2/agents/{id}/home` (a home's packed export and import) are gone (`404`, and out of the served OpenAPI document): read and write a home's files with `/v2/agents/{id}/home/files`.
- `POST /v2/runs/{id}/kill` is gone (`404`): end a run with `POST /v2/runs/{id}/stop` or `/cancel`.
- The `no_sealing_key` error code is gone: the server always has its seal key, so drop any branch on it.
- `seal_key_missing` is gone from a tool key's `reenter.reason` and a webhook's `signing`: what does not open says `seal_key_changed` (tool keys) or `unreadable` (webhook).
- The `store_unreadable` error code is gone, and `GET /v2/settings/mcp-servers` no longer sends `file_unreadable`: drop those branches.
- Now required in answers: a run's `place` (`GET /v2/runs/{id}`), and capabilities' `models`, `places` (with `places.default_place`), `tools` and `learning`: a client validating answers against the document may read them without a presence check.
