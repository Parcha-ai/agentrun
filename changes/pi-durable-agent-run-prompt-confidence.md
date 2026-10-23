---
packages: @parcha/pi-durable-agent
kind: feature
---
`startRun` and `prepareRun` take an optional `confidence` (a number from 0 to 1) in a run's `prompt`, `{ id, reason, confidence? }`, and record it on the run in `agent.runs`; a `confidence` outside 0 to 1, or not a number, is refused (`invalid`) before anything is written.
