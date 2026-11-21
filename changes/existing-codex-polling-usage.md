---
packages: repo, @parcha/agentrun-serve
kind: feature
---
Observe token usage from already-running Codex sessions without restarting their native processes. Polling subscriptions follow loaded interactive, exec and delegated sessions; explicitly selected historical sessions remain available. Input, output and reported cache counters use native model metadata and source UTC dates, with cumulative baselines, atomic local checkpoints and sequence deduplication preventing duplicate accounting.

Polling usage requires the receiver’s advertised capability. Existing lifetime totals are not backfilled; missing counters, tail gaps and queue drops remain partial coverage. Conversation content stays local, existing learning consent is unchanged, and OTLP ingestion keeps its existing behavior.

Selected failed sessions remain eligible for bounded usage polling, so counters flushed after Codex reports a system error are retained. Acknowledged counters are not counted again after another poll or a connector restart.
