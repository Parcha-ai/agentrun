---
packages: @parcha/pi-durable-agent
kind: feature
---
The agent store records a session another harness ran on this machine (Claude Code, Codex or pi) as a run that has already ended. `store.importRun({ agent, revision, state, startedAt, endedAt, costUsd?, summary?, source, session })` writes the run at the source's own times plus a `run_imports` row naming its source and session, in one transaction, and makes the run's directory and store directory 0700 whatever the umask, and `runs/` too when the import makes it. A time that does not exist (`2026-02-30`) is refused, never rolled to another date. The same source and session imports once. The reads carry `importedFrom`. An imported run is read-only: `reopenRun` and `carryBack` refuse it, and a trigger in `store.sqlite` refuses any change to its row, so a version that does not know imports cannot change one either. The table comes without a new store version.
