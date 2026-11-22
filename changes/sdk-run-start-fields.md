---
packages: @parcha/agentrun-serve
kind: feature
---
A backend SDK run (`POST /agents/{agent_id}/sdk-runs`) can now run longer than an hour, be reported after it began, and carry its own title and labels.
- Each events batch, an empty `events: []` one included, moves the run's deadline to an hour after that batch, up to 24 hours after its start. A run that misses its deadline still ends with an unknown outcome, as before.
- The start takes optional `started_at` (RFC 3339, at most 60 seconds ahead of the server's clock and 7 days behind it), which becomes the run's `created_at`. The deadline is still counted from the start request. Those bounds apply to a new start only: a retry under the same `Idempotency-Key` and body of a start that was made gets that run's receipt, however late it comes.
- The start takes optional `title` (trimmed, 1 to 200 characters), used instead of the input's first 80 characters, and `labels`, under the same rules as `RunCreate.labels`, so `GET /runs?label=<key>:<value>` finds the run. A label holding a server secret is refused.
- `GET /capabilities` says so in `features.sdk_runs`: `{ started_at: true, title: true, labels: true, max_open_s: 86400 }`.
- A start without these fields behaves as before. They are for SDK runs; a CLI learning turn takes none of them and keeps its 24-hour window.
