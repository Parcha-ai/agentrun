---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A cancel means cancel: once a run is cancelled, its process sends no model request, however the cancel and the process's start interleave. serve marks the cancel in the run's directory before it reaches for the run's process, and the run's process refuses, before it is sent or counted, any request it would make after that mark. A cancelled run sends no compaction summary either, and a request it refused is not counted as one: the timeline skips pi's error entry for it (`REQUEST_REFUSED`). A request is checked against the cancel twice: once before its start is marked, and again after, right before it leaves. A cancel that lands while the mark is being written still stops the request, and its start is then withdrawn (`REQUEST_ENDED` with `unsent: true`), so the run's cost counts only what was sent.
