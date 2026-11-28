---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve import` checks again, as it writes each run, that none of the run's files (a session's own, a subagent's, or a SQLite store's write-ahead log, through each reader's size and last write) was written in the last 10 minutes. The plan judges each session before it reads the others, so a session resumed in the meantime was imported as done and then held as unchanged by every later import. Now it is left out as live, with the plan's wording, and an import after it ages takes it whole.
- A run left out after its read (a subagent still being written, or one over the run's cap found after its own file was read) no longer leaves its records counted as the import's: each run reads through its own staged set, joined to the import's only once the run is written. A later session in the same import that copies those records counts them, as none of them was saved.
