---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
Record tasks executed by existing Claude Agent SDK and Codex SDK backends through scoped, idempotent run receipts. Keep execution and cancellation in the application while the server records bounded evidence, independently checks opt-in notes and skills, pins accepted context for later tasks, and accounts for SDK and reflection usage without inventing unknown counters.

Keep completed, failed and cancelled SDK runs in the learning cost series by persisting their canonical execution path with terminal usage. A failed or stalled terminal read leaves cost and metrics unknown, and a stop received during that read is taken with the end rather than lost.

When the backend marks its evidence incomplete, retain valid cost and token aggregates but leave its execution path unknown, so the learning cost series counts and excludes that partial trace.

Failed or cancelled SDK runs record why learning stopped alongside their final state, without asking a reflection model or leaving learning shown as seeded.

Keep the task's original cost and answer time with the first reflection prompt. Recovery reuses that snapshot and the paid answer, preserving the task/reflection breakdown and unknown costs when the run's terminal commit was interrupted.

Keep each workflow compilation attempt under its own durable request ID, distinct from reflection and retry attempts. Recover the first task-cost snapshot within the same learning round, including compile-only rounds, without borrowing another round's figures or resending an answered request.

SDK callback tools never list or pin tools from AgentRun's managed MCP registry, including when an inline managed launch is refused. Backend starts and evidence recording remain independent of a missing or unavailable managed server.

SDK reflection repairs carry their original format instructions and bounded, redacted rejected answer from the same durable learning round. A reclaimed run reuses both answers without another paid dispatch; compiler retries retain their separate context and request IDs.

Keep grades of completed SDK runs as evidence without reopening application-owned execution onto managed feedback rounds. Their scoped completion receipts and existing learning remain terminal.

Arbitrate SDK completion and deadline/error closure on the same durable evidence inbox, fenced by the runner's current claim. Acknowledged completion keeps its answer and usage for processing or recovery; a closed inbox refuses new evidence while exact retries remain idempotent. Initial read failures settle unknown cost and unasked dropped learning only when closure and the terminal journal can be saved; otherwise the run remains recoverable without replaying the backend task.
