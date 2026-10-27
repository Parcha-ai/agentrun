---
packages: @parcha/pi-durable-agent
kind: feature
---
The agent store archives an agent or a run without deleting it: `store.setArchived("agent" | "run", id, archived)` appends one row to a new `archive_changes` table when the state changes, and `listAgents`, `readAgent`, `listRuns` and `readRun` carry `archivedAt` while an item is archived (a run's own, else its agent's). The rows are written once: the database refuses an `UPDATE` or a `DELETE`. The table needs no new store version: a store an earlier version wrote opens and reads with nothing archived, and an earlier version still opens a store that has the table. The store page hides archived agents behind Show archived and marks archived agents and runs, and its host hook takes `run(run)` for a stored run's head.
