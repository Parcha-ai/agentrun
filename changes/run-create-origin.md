---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A run create retried with the same `Idempotency-Key` after the server went down mid-create now answers the run the first try made, never a second run. The agent store records the key's origin in the transaction that writes the run: `store.startRun({ agent, origin: { key, fingerprint? } })` starts one run per key and, asked again (or by two starts at once), returns that run with `existing: { fingerprint? }` and writes nothing; `store.runOfOrigin(key)` reads it. The new `run_origins` table comes without a new store version. `POST /v2/agents/{agent_id}/runs` gives the store its key's slot and body, hashed, so a retry after a restart replays the run (`Idempotent-Replayed: true`) and another body under the key is still `409 idempotency_mismatch`; a create's key is kept with its run, past `limits.idempotency_ttl_s`.
A run the server went down on after the store made it and before it was set up (no `serve.json`) used to be relaunched with no input and stay queued for good; the next start now fails it with `error.details.reason` `server_lost_at_setup`, and never launches it.
