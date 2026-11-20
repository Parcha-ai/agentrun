---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
`POST /v2/templates/{template}/apply` now answers `revision_version`: the number of the agent's revision the apply wrote, its current one now (`1` for an agent it made; on an update with `agent_id`, the new revision's). This is a public API addition: the TypeScript and Python clients carry the field, and the console says "Updated: rev N" from it with no second read of the agent. A purged run's answer and input no longer stay in the server's in-process caches after its `DELETE` (or its agent's): the purge drops them. A SQLite purge whose WAL checkpoint another connection holds back now leaves the store's scrub marker (`store.sqlite.scrub`), and the next start's scrub truncates the log before it serves, a crash in between included; it no longer retries or logs a warning.
