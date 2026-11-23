---
packages: @parcha/agentrun-serve
kind: feature
---
The console starts a race at `#/races/new` (New race, on the Runs list's toolbar): one task, a cost cap per lane, and 2 to 4 lanes, each a harness and a model this server runs. Start sends one inline run per lane (POST /v2/runs) with the labels the race view reads (`race`, `lane`, `harness`, `model`), then opens `#/races/<label>` once every lane has a run.
- Each lane is an agent of its own (external id `race-<label>-<n>`), with one revision per harness and model, so changing a lane after a refusal makes a new revision rather than a conflict.
- A lane the server refuses shows the server's words in its own place, and the other lanes start anyway. Start again sends only the lanes left, each under the Idempotency-Key its first request had, so no lane starts twice.
- A new race's label is its start time (UTC, to the minute) and four random characters.
