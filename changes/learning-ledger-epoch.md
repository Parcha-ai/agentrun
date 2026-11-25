---
packages: @parcha/agentrun-serve
kind: breaking
---
Breaking for runners: Postgres migration 0030 drops `learning_ledger.epoch` and raises the runner floor to 30. Stop runners of earlier builds before this build's server starts; they fail on the new schema. On SQLite the server drops the column at its start, and a runner waits for that server.
- The server records a ledger row for each ended run that has none at its open, 64 runs per transaction. A stop partway resumes at the next open. Once every run has its row, the store is marked and later opens skip the scan. Reads no longer record rows.
- Before dropping the column, the upgrade deletes the rows the earlier build could leave wrong, and the open records them again from their runs: a row with no path, a row behind its run's epoch, an unknown cost the run now has, and an audit shadow on another path.
- The read of runs by hand before the money rule's window uses a new index, `learning_ledger_by_hand`, instead of sorting every ledger row of the agent.
