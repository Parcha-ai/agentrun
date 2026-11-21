---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
Connect independently started Codex CLI and Claude Code sessions with `learning connect`, without
an SDK wrapper or replacing the source task launcher. Hooks record completed prompt windows and
reported usage; later prompts receive pinned owner corrections from AgentRun. Source task dialogue
never becomes a standing correction automatically. Source hooks do not expose a workflow execution
bridge or launch extra native reflection sessions. Retired automatic notes and skills stay on disk
but are not served or converted to owner corrections. Existing CLI profiles with a stored
`learning: "notes"` setting read as enabled under the current learning model; new definitions use
its boolean or loop settings.

Connection credentials are scoped, installation preserves unrelated hooks, and disconnect removes
only its own hooks. Incomplete evidence and cancellations stay explicit. The console offers capture
and correction delivery enrollment for existing applications while execution and editing stay in
their original setup. Initial enrollment requires a local AgentRun server and the selected CLI's
sign-in; metadata observation alone does not enable it.

Private pending capture journals are bound to their destination and credential generation. A reconnect
starts a fresh journal; prior or unbound records remain on disk and are not automatically migrated,
uploaded or deleted. `learning retry` reports `blocked_journals` and exits with status 1 when those
records need review.

Disconnect disables local capture before removing hooks or contacting the server. If server revocation is
pending, loaded hooks and retries stay disabled until disconnect completes; status exposes `capture_enabled`.
