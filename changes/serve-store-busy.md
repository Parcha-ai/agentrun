---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
**serve no longer stalls while another process holds the agent store**
- Every read and write of the agent store waits for a busy store without blocking the server, so other requests are still answered meanwhile. Before, one write could hold up every request for up to 5 s.
- A request waits up to about 2 s for the store, then answers `409 home_busy` with `retry_after_ms`. A run's end keeps trying until it is written.
- Creating an agent while the store was busy answered `409 agent_exists`, and a read answered `500 internal`. Both now wait, then answer `home_busy` if the store stays busy.
- `openStore(dir, { busyTimeoutMs })` and `openStoreReader(dir, { busyTimeoutMs })` set how long a call waits synchronously for a busy store before it throws (default 5000, as before).
