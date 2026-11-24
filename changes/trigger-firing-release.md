---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
A launch hook's host can release a firing it answered 2xx but will start no run for: `POST /v2/triggers/{trigger_id}/firings/{firing_id}/release` with `{ "error": "<plain words>" }`. The firing is `failed` at once (`host_released`, with the host's words) and its trigger's place under `max_active_runs` frees. Before, the firing held that place until its `start_by`, 10 minutes later, so the next firings waited. When a release waits and what it refuses are stated once, in the route's OpenAPI description; how it meets a run's `trigger_firing` start, in that field's. The CLI has `agentrun triggers release-firing`, and the TypeScript and Python clients have `triggers.releaseFiring` / `triggers.release_firing`.
