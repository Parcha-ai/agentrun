---
packages: @parcha/agentrun-serve
kind: feature
---
Setup's import fills the console first and the transcripts after, and says how far it has got.
- The import at setup writes every run's row and serve.json first (the index pass), newest projects first, and then the transcripts. Mission Control, Agents and Runs are complete once the first pass ends. Each row's metrics and estimate are read from the entries its transcript holds, so the second pass changes no row, and the two passes write what one pass of `agentrun-serve import` writes. A server stopped between the passes keeps the owner's yes, and its next start writes the missing transcripts without making a run twice.
- While it runs, `GET /v2/setup/import` answers `{ state: "running", started_at }`, and once the worker has planned, `phase` (`index` or `transcripts`), `total`, `runs` (rows in), `transcripts` and `agents`.
- A run opened before its transcript lands answers its timeline with `transcript: "importing"`, no rows, `final: false` and `poll_after_ms`, and its next read finds the transcript once it is written. An event stream for it sends that page and closes with a retry.
- `GET /v2/stats` answers through a busy store with its last good answer for the same filter and `as_of`, rather than `409 home_busy`, once it has one.
- The console shows the import's progress ("1,240 of 2,500 sessions · 74 agents · about 10 s left", with a bar, then the transcripts), reads Mission Control, Agents and Runs again every 2.5 s in place while it runs, keeping what they show through a failed read, and says on a run's page that its transcript is still being imported.
