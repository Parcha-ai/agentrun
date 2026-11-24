---
packages: @parcha/agentrun-serve
kind: feature
---
The console starts a race at `#/races/new` (New race, on the Runs list's toolbar): one task, a cost cap per lane, and 2 to 4 lanes, each a harness and a model this server runs. Start sends one inline run per lane (POST /v2/runs) with the labels the race view reads (`race`, `lane`, `harness`, `model`), then opens `#/races/<label>` once every lane has a run.
- Each lane is an agent of its own (external id `race-<label>-<n>`), with one revision per harness and model, so changing a lane after a refusal makes a new revision rather than a conflict.
- Each lane gets the tools a new agent gets on this server: every tool its harness runs here, plus the shell where the server's default place is a box. An inline run is granted no tools of its own, so a lane without them could not touch a file. A lane names no place, so the server puts it where it puts that new agent: in the box only with the shell (pi), and on the runner for an adapter harness such as codex or claude-agent, where Claude Code's login works and no box starts.
- Each lane stays in the Agents list as an inline agent; DELETE removes one.
- A lane the server refuses shows the server's words in its own place, and the other lanes start anyway. Start again sends only the lanes left, each under the Idempotency-Key its first request had, so no lane starts twice.
- A lane whose answer never came whole (a lost answer, a timeout, a 5xx, a start the server is still making) may have started, so it says so and keeps its harness, model and the race's task and cap. Start again sends the same request under the same key, and the server answers with the run if it made one. Only a refusal lets a lane change.
- Lanes are seeded when capabilities first name a harness that runs, so a race never starts with fewer than two.
- A new race's label is its start time (UTC, to the minute) and twelve random hex characters, so two races started in the same minute never share a race page.
