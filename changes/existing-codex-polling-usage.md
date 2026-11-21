---
packages: repo, @parcha/agentrun-serve
kind: feature
---
Observe token usage from already-running Codex sessions without restarting their native processes. Polling subscriptions follow loaded interactive, exec and delegated sessions; explicitly selected historical sessions remain available. Input, output and reported cache counters use native model metadata and source UTC dates, with cumulative baselines, atomic local checkpoints and sequence deduplication preventing duplicate accounting.

Polling usage requires the receiver’s advertised capability. Existing lifetime totals are not backfilled; missing counters, tail gaps and queue drops remain partial coverage. Conversation content stays local, existing learning consent is unchanged, and OTLP ingestion keeps its existing behavior.
