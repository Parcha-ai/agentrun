---
packages: @parcha/agentrun-serve
kind: feature
---
The console shows a race at `#/races/<label>`: the runs that carry the label `race:<label>`, up to four lanes side by side, each following its run live. A lane shows the harness and model from its run's `harness` and `model` labels, its status, cost against its cap, tokens, tool calls (and how many failed) and its running time, over its newest steps. Lanes are ordered by their `lane` label, never by start time; a run with no `lane` label comes last. The page reads the race again every 15 seconds, so a lane that starts late joins it.
- Start a race from the form at `#/races/new`, or start each run yourself with `labels: {"race": "<label>", "lane": "1", "harness": "...", "model": "..."}` (POST /v2/runs or POST /v2/agents/{agent_id}/runs).
- Each lane waits about 3 seconds per timeline read instead of 25, so four lanes leave room within the browser's six connections to the server.
