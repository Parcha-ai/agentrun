---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
On the runner, a learned workflow node that names a tier (`fast`, `strong`) now runs on the host's model of that tier (`AGENT_MODEL_FAST`, `AGENT_MODEL_STRONG`) instead of the run's own model. Its requests take the run's one route and stay under the run's cap, and each is booked at its own model's price. A tier the host names no model of still runs on the run's own model. A tier whose model can't be reached fails the workflow call and names why; it never runs on another model. This holds on every harness: pi, Claude Agent, Codex and OpenCode. On a CLI harness the tier's requests go through a proxy of their own beside the CLI session's, never through the CLI. `AdapterSession.port` and the run ledger's `models` take an optional `tier`.
Upgrading: nothing to do.
