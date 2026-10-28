---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A run's cost includes pi's compaction summaries. A summary is a paid model request that pi books only in its own usage document, never as an entry the run's timeline sums, so a run that compacted under-counted its cost and its requests, and /usage with it. serve now marks a summary's request like a generation's (`request: "compaction"`) and writes its cost (`REQUEST_COST`, `agentrun.request_cost`), which the timeline counts and sums; one aborted before its answer, or open when the run settles, makes the cost unknown. A run that compacts also completes again: serve counted the messages still to arrive from the number of user rows the run showed, and a woken run's compacted conversation shows fewer, which read as messages still waiting, so the run stayed working; they are now counted by id.
