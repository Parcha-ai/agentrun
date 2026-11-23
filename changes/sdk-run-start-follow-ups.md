---
packages: @parcha/agentrun-serve
kind: fix
---
A backend SDK run's start (`POST /agents/{agent_id}/sdk-runs`) follows every run's rules for its new fields, and an agent holds a bounded number open.
- `started_at` is served as the run's `created_at`, and the run keeps its arrival as its start for ordering: it is claimed in arrival order and counted in learning's windows as it arrived.
- `title` goes under every run's title rule (one line, cut at 80 characters) instead of being refused past 200, and a server secret in it is cut.
- A label holding a server secret is refused 422 under `labels.<key>`, on every run's start (`RunCreate` too). A label key that holds one is refused under `labels`, and the refusal doesn't repeat the key.
- An agent holds at most 8 SDK runs open at once: the next start is 429 `rate_limited` until one completes, is cancelled or its inbox closes. Starts sent at once are admitted one at a time per agent, so together they never pass the cap. `features.sdk_runs.max_open_per_agent` says so.
