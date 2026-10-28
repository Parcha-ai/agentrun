---
packages: @parcha/agentrun-serve
kind: fix
---
**serve no longer stalls while another process holds the agent store**
- Every read and write of the agent store waits for a busy store without blocking the server, so other requests are still answered meanwhile. Before, one write could hold up every request for up to 5 s.
- A request waits up to about 2 s for the store, then answers `409 home_busy` with `retry_after_ms`. A run's end keeps trying until it is written.
- Creating an agent while the store was busy answered `409 agent_exists`, and a read answered `500 internal`. Both now wait, then answer `home_busy` if the store stays busy.
- An edit that waits for the store is checked against the revision current when it commits, so two edits held up together cannot both write: the second gets `422` at `definition.version`, or, being the same edit, the revision the first made.
- A workflow run that ends while the store is held waits for it as long as a run's end does, and one still held after that is settled again every 30 s, not left until the next start.
- A run's answer is read at one moment: a run that ends while its read waits answers ended, with its result.
