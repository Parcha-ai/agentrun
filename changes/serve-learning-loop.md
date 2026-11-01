---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
An agent with learning on remembers, on pi, claude-agent and codex: when a run answers or fails, the server asks the same session one end-of-run turn to add notes to its copy of the agent's learning folder; what it adds is checked, graded by one grader on the agent's own model, and merged into the folder's `main`, where the next run reads it.
- The turn goes through the run's door under a fixed request id, at most once, marked as the server's (`turnOrigin: "reflect"`), under the run's cap; the run's answer stays the job's, and the turn's rows are labelled `learning`. `startServe` takes `reflectTimeoutMs` (default 5 minutes).
- What it wrote is read without following a link and checked by packages/learn's `checkProposal` before anything is written; `MEMORY.md` as the turn left it is ignored. The grader is packages/learn's `gradePrompt` and `parseVerdict`, fail-closed; an injection screen runs first only with Jev's key. The merge is one host commit: new notes, superseded ones marked, `MEMORY.md` rebuilt, a `Run-Id` trailer, compare-and-swap on `main`, never twice.
- The run's `learning` gains the states `reflecting`, `proposed` and `merged` and the drop reasons of the console's closed list; a learning timeline row (kind `learning`) is shown for every outcome, `seed_failed` included. `GET /usage` books each grade under the meter `learning`, and `GET /stats` gains `learning: {runs, merged, dropped, in_progress}` over its filters.
- `@parcha/pi-durable-agent`: `TimelineKind` gains `learning`.
