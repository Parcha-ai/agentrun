---
packages: @parcha/agentrun-serve
kind: feature
---
Receive polling and native OpenTelemetry observations from independently running Claude Code and Codex sessions using the existing AgentRun CLI protocol. Scoped credentials, selection fences, durable deduplication and bounded retention preserve activity and token accounting across reconnects and restarts. Observation is read-only and does not enable self-improvement or take over execution.

Reconnecting a revoked source can adopt its newly approved polling or telemetry mode without losing accepted history. Fresh credentials and selection revisions fence old uploads, and each mode's source clock remains independent. Missing cache usage stays unknown, and receipt capacity is counted once per batch.
Observation reads and retention scans select their own settings namespace before loading values, avoiding unrelated remote command history.
