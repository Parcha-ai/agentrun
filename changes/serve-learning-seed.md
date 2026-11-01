---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent, @parcha/agentrun-learn
kind: feature
---
An agent whose definition says `learning: true` starts every run from what it has learned, on pi, claude-agent and codex alike. Learning is off unless the agent says so, and the server's `--learning off` (or `AGENTRUN_SERVE_LEARNING=off`) turns it off for every run; capabilities report the switch as `features.learning`.
- The agent's learning folder, `DATA/homes/<agent id>/learning/`, is in Claude Code's auto-memory format: `MEMORY.md`, one line per active note (`- [name](file.md) — description`), and one `<slug>.md` per note with `name`, `description`, `type` (`user`, `feedback`, `project`, `reference`) and optionally `status: superseded | retired` with `superseded_by`. It is plain git with `main` checked out, made by the agent's first run that learns with an empty `MEMORY.md`, and the server is its only writer, with hooks, fsmonitor, lazy fetches and system and global config off.
- Each run pins `main`'s commit in `runs/<id>/learning.json`, kept through a resume or a follow-up. The first 200 lines of that commit's `MEMORY.md` go into the run's instructions under `# Learned`, and `MEMORY.md` and the active notes are copied into the run's `work/.learning/`.
- A learning fault never blocks a run: a folder that cannot be made or read starts the run with nothing learned. The run's `learning` reads `{state: "seeded"}`, `{state: "dropped", reason: "seed_failed"}`, or `null` for a run that does not learn; run lists carry `{state, reason}`.
- `@parcha/pi-durable-agent`: an agentic revision keeps `learning` when its input sets it, so a definition that leaves it out keeps its revision id.
- `@parcha/agentrun-learn`: `parseNoteFile`, `activeNotes`, `buildIndex` and `loadedIndex` read and build the folder's format.
