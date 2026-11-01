---
packages: @parcha/pi-durable-agent
kind: feature
---
The agent store keeps a run's metrics: its tokens, model requests, models and tool calls, beside its row. `runMetricsOf(records)` from `@parcha/pi-durable-agent/timeline` makes them from the entries of all of a run's conversations, counting requests as the usage row does; an aborted response's partial usage, a cost written with no usage and a request cut before its answer are counted in `unmetered`, never summed as 0 tokens. `carryBack(runId, { ..., metrics })` and `importRun({ ..., metrics })` write them, with what only the host knows (`activeMs`, `effort`, `model`, `costUsdEst`, `costBasis`), in the transaction that writes the run's row; a run opened again and ended again has them replaced. `store.runMetrics(runId)` reads them back. The new `run_metrics` and `run_tool_metrics` tables come without a new store version: an earlier version still opens the store and reads every run.
