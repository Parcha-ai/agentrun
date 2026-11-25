---
packages: @parcha/agentrun-serve
kind: breaking
---
Breaking for runners: Postgres migration 0030 drops `learning_ledger.epoch` and raises the runner floor to 30. Stop runners of earlier builds before this build's server starts; they fail on the new schema. On SQLite the server drops the column at its start, and a runner waits for that server.
- The server records a ledger row for each ended run that has none, once, at its open. Reads no longer record rows.
