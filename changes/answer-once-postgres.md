---
packages: @parcha/agentrun-serve
kind: fix
---
On a Postgres store, an approve and a deny of one tool call sent at once now write one answer: the first one written wins, the other is 409 `not_continuable` with details `{reason: already_answered, decision}`, and the run acts on the winner only. SQLite already refused the second answer with its one-answer index; Postgres had no such index, so both could be written. A new migration (0003) adds it.
- Upgrading: nothing to change. The server applies the migration at its start.
